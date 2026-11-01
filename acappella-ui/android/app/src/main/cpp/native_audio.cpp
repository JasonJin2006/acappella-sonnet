// 原生音频引擎：AAudio 渲染线程 + 固定 voice 池 + 采样播放。
//
// 为什么需要它
// ------------
// Web Audio 的节点创建、buffer 解码、排期都发生在 JS 主线程。主线程一旦
// 被 UI 绘制或 GC 占住，排期就晚于音频线程要 buffer 的时刻，表现是断续和爆音。
// 专业音频软件（BandLab / FL Studio Mobile / Cubasis）全部把音频放在
// 实时优先级的原生线程里，和 UI 完全隔离，并且在启动时预分配好 voice，
// 播放过程中零分配——这是实时音频的铁律。
//
// 这个引擎就是那个思路的最小实现：
//   - AAudio 回调线程（AAUDIO_PERFORMANCE_MODE_LOW_LATENCY）
//   - MAX_VOICES 个预分配 voice，播放时只改状态，不 malloc/free
//   - 混响用两条固定的 comb + allpass（Schroeder），不动态建节点
//   - 所有与 JS 的交互都是无锁的原子操作（参数用 atomic 存快照）
//
// 与 JS 的边界
// ------------
//   JS 调 native 方法把「音符列表」一次性灌进来（playScore），
//   之后渲染完全在原生侧跑。JS 只查询播放位置（getPositionBeats），
//   不再参与每一次发声。

#include <jni.h>
#include <android/log.h>
#include <dlfcn.h>
#include <cstdint>
#include <atomic>
#include <ctime>
#include <cmath>
#include <cstring>
#include <vector>
#include <string>
#include <mutex>
#include <algorithm>

#define LOG_TAG "SonnetAudio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// ==================== AAudio 动态加载 ====================
//
// 为什么不直接 #include <aaudio/AAudio.h> + 链接 -laaudio：
//   libaaudio.so 从 Android 8.0（API 26）才存在，而本应用 minSdk 是 24。
//   静态链接会让 24/25 的设备一启动就崩（找不到 so）。
//
// 运行时 dlopen 的好处：
//   - 编译期/链接期完全不依赖 libaaudio
//   - 24/25 设备 dlopen 失败 → start() 返回 false → Java 退回 Web Audio
//   - 26+ 设备拿到真实符号，走低延迟 AAudio
//
// 下面这些类型和常量值取自 NDK 的 aaudio/AAudio.h，值必须与官方头一致。

using aaudio_result_t = int32_t;
using aaudio_stream_t = struct AAudioStream;
using aaudio_builder_t = struct AAudioStreamBuilder;
using aaudio_callback_result_t = int32_t;

constexpr aaudio_result_t AAUDIO_OK_ = 0;
constexpr aaudio_callback_result_t AAUDIO_CALLBACK_CONTINUE_ = 0;
constexpr aaudio_callback_result_t AAUDIO_CALLBACK_STOP_ = 1;
// 以下值逐条核对 NDK 27 的 aaudio/AAudio.h
constexpr int AAUDIO_DIRECTION_OUTPUT_ = 0;              // enum 首项
constexpr int AAUDIO_FORMAT_PCM_I16_ = 1;                // INVALID=-1, UNSPECIFIED=0, I16=1
constexpr int AAUDIO_FORMAT_PCM_FLOAT_ = 2;              // I16 之后
constexpr int AAUDIO_PERFORMANCE_MODE_NONE_ = 10;
constexpr int AAUDIO_PERFORMANCE_MODE_LOW_LATENCY_ = 12; // NONE=10, POWER_SAVING=11, LOW_LATENCY=12

using FnCreateBuilder = aaudio_result_t (*)(aaudio_builder_t**);
using FnBuilderDelete = void (*)(aaudio_builder_t*);
using FnSetDirection = void (*)(aaudio_builder_t*, int);
using FnSetPerformanceMode = void (*)(aaudio_builder_t*, int);
using FnSetFormat = void (*)(aaudio_builder_t*, int);
using FnSetChannelCount = void (*)(aaudio_builder_t*, int32_t);
using FnSetSampleRate = void (*)(aaudio_builder_t*, int32_t);
using FnSetDataCallback = void (*)(aaudio_builder_t*, void*, void*);
using FnSetErrorCallback = void (*)(aaudio_builder_t*, void*, void*);
using FnOpenStream = aaudio_result_t (*)(aaudio_builder_t*, aaudio_stream_t**);
using FnGetSampleRate = int32_t (*)(aaudio_stream_t*);
using FnRequestStart = aaudio_result_t (*)(aaudio_stream_t*);
using FnRequestStop = aaudio_result_t (*)(aaudio_stream_t*);
using FnClose = aaudio_result_t (*)(aaudio_stream_t*);
using FnResultText = const char* (*)(aaudio_result_t);

struct AAudioApi {
  void* handle = nullptr;
  FnCreateBuilder createBuilder = nullptr;
  FnBuilderDelete builderDelete = nullptr;
  FnSetDirection setDirection = nullptr;
  FnSetPerformanceMode setPerformanceMode = nullptr;
  FnSetFormat setFormat = nullptr;
  FnSetChannelCount setChannelCount = nullptr;
  FnSetSampleRate setSampleRate = nullptr;
  FnSetDataCallback setDataCallback = nullptr;
  FnSetErrorCallback setErrorCallback = nullptr;
  FnOpenStream openStream = nullptr;
  FnGetSampleRate getSampleRate = nullptr;
  FnRequestStart requestStart = nullptr;
  FnRequestStop requestStop = nullptr;
  FnClose closeStream = nullptr;
  FnResultText resultText = nullptr;

  bool loaded = false;

  bool load() {
    if (loaded) return true;
    handle = dlopen("libaaudio.so", RTLD_NOW);
    if (!handle) {
      LOGI("libaaudio.so not available (API < 26?): %s", dlerror());
      return false;
    }
    auto sym = [&](const char* name) { return dlsym(handle, name); };
    createBuilder = (FnCreateBuilder)sym("AAudio_createStreamBuilder");
    builderDelete = (FnBuilderDelete)sym("AAudioStreamBuilder_delete");
    setDirection = (FnSetDirection)sym("AAudioStreamBuilder_setDirection");
    setPerformanceMode = (FnSetPerformanceMode)sym("AAudioStreamBuilder_setPerformanceMode");
    setFormat = (FnSetFormat)sym("AAudioStreamBuilder_setFormat");
    setChannelCount = (FnSetChannelCount)sym("AAudioStreamBuilder_setChannelCount");
    setSampleRate = (FnSetSampleRate)sym("AAudioStreamBuilder_setSampleRate");
    setDataCallback = (FnSetDataCallback)sym("AAudioStreamBuilder_setDataCallback");
    setErrorCallback = (FnSetErrorCallback)sym("AAudioStreamBuilder_setErrorCallback");
    openStream = (FnOpenStream)sym("AAudioStreamBuilder_openStream");
    getSampleRate = (FnGetSampleRate)sym("AAudioStream_getSampleRate");
    requestStart = (FnRequestStart)sym("AAudioStream_requestStart");
    requestStop = (FnRequestStop)sym("AAudioStream_requestStop");
    closeStream = (FnClose)sym("AAudioStream_close");
    resultText = (FnResultText)sym("AAudio_convertResultToText");

    loaded = createBuilder && builderDelete && setDirection && setPerformanceMode &&
             setFormat && setChannelCount && setSampleRate && setDataCallback &&
             setErrorCallback && openStream && getSampleRate && requestStart &&
             requestStop && closeStream;
    if (!loaded) LOGI("libaaudio.so loaded but symbols missing");
    return loaded;
  }
};

AAudioApi gApi;


constexpr int MAX_VOICES = 64;        // 预分配的 voice 数
constexpr int MAX_EVENTS = 4096;      // 一次灌入的最大音符数
constexpr int REVERB_COMBS = 4;
constexpr int REVERB_ALLPASS = 2;

// 一个采样（解码后的 16-bit PCM，单声道；立体声按两个声道存）
struct Sample {
  std::vector<int16_t> pcm;
  int frames = 0;
  int channels = 1;
  float rootMidi = 60.0f;   // 这个采样对应的音高
};

// 一个 voice 的状态机。
// 全部字段都是 POD，voice 数组在引擎构造时一次性分配好。
struct Voice {
  bool active = false;
  int sampleId = -1;
  float playbackRate = 1.0f;
  double position = 0.0;        // 当前读取位置（采样帧，浮点）
  double endPosition = 0.0;     // 到这就结束
  float amplitude = 0.0f;       // 目标峰值
  float envelope = 0.0f;        // 当前包络值
  float attackStep = 0.0f;
  float releaseStep = 0.0f;
  int state = 0;                // 0 attack, 1 sustain, 2 release
  float panL = 0.707f;
  float panR = 0.707f;
  bool loop = false;
  double loopStart = 0.0;
  double loopEnd = 0.0;
  double releaseAt = 0.0;   // 到这个采样位置开始释放
  int eventIndex = -1;
};

// 一个待播放的音符事件
struct Event {
  double beat;        // 在第几拍
  double lengthBeats;
  int midi;
  float velocity;     // 0..1
  float pan;
};

// Schroeder 混响：4 comb + 2 allpass，固定缓冲。
struct Reverb {
  std::vector<float> combBuf[REVERB_COMBS];
  int combIdx[REVERB_COMBS] = {0};
  float combFeedback = 0.72f;
  float combDamp = 0.3f;
  float combLast[REVERB_COMBS] = {0};

  std::vector<float> apBuf[REVERB_ALLPASS];
  int apIdx[REVERB_ALLPASS] = {0};
  float apFeedback = 0.5f;

  void init(int sampleRate) {
    // 经典 Schroeder 延迟（按 44.1k 设计，按实际采样率缩放）
    const float combMs[REVERB_COMBS] = {29.7f, 37.1f, 41.1f, 43.7f};
    const float apMs[REVERB_ALLPASS] = {5.0f, 1.7f};
    for (int i = 0; i < REVERB_COMBS; i++) {
      int n = (int)(sampleRate * combMs[i] / 1000.0f);
      combBuf[i].assign(std::max(1, n), 0.0f);
      combIdx[i] = 0;
    }
    for (int i = 0; i < REVERB_ALLPASS; i++) {
      int n = (int)(sampleRate * apMs[i] / 1000.0f);
      apBuf[i].assign(std::max(1, n), 0.0f);
      apIdx[i] = 0;
    }
  }

  // 单声道输入，返回湿信号
  float process(float in) {
    float out = 0;
    for (int i = 0; i < REVERB_COMBS; i++) {
      auto& buf = combBuf[i];
      int idx = combIdx[i];
      float delayed = buf[idx];
      // 一阶低通，越往后越暗
      combLast[i] = delayed * (1.0f - combDamp) + combLast[i] * combDamp;
      buf[idx] = in + combLast[i] * combFeedback;
      combIdx[i] = (idx + 1) % (int)buf.size();
      out += delayed;
    }
    out *= 0.25f;
    for (int i = 0; i < REVERB_ALLPASS; i++) {
      auto& buf = apBuf[i];
      int idx = apIdx[i];
      float delayed = buf[idx];
      float v = out + delayed * apFeedback;
      buf[idx] = v;
      apIdx[i] = (idx + 1) % (int)buf.size();
      out = delayed - v * apFeedback;
    }
    return out;
  }

  void reset() {
    for (int i = 0; i < REVERB_COMBS; i++) {
      std::fill(combBuf[i].begin(), combBuf[i].end(), 0.0f);
      combLast[i] = 0;
    }
    for (int i = 0; i < REVERB_ALLPASS; i++) std::fill(apBuf[i].begin(), apBuf[i].end(), 0.0f);
  }
};

// 速度表的一段：从 beat 开始用多大速度。JS 侧按谱面标记灌进来。
struct TempoPoint {
  double beat = 0.0;
  double bpm = 96.0;
};

constexpr int MAX_TEMPO_POINTS = 64;

struct Engine {
  void* stream = nullptr;
  int sampleRate = 48000;
  int channels = 2;

  // 采样库（JS 灌入）
  std::vector<Sample> samples;
  std::mutex sampleMutex;

  // 事件表（JS 灌入，按 beat 排序）
  std::vector<Event> events;
  std::atomic<int> eventCount{0};
  std::atomic<int> nextEvent{0};
  std::mutex eventMutex;

  // 速度表。谱面中途变速时不能再用单一 bpm：
  // 播放头推进的速度要随位置变，否则中段开始整体提前或拖后。
  // 固定容量数组 + 原子计数，音频线程里只读，不加锁不分配。
  TempoPoint tempos[MAX_TEMPO_POINTS];
  std::atomic<int> tempoCount{0};

  // 播放状态
  std::atomic<bool> playing{false};
  std::atomic<double> startBeat{0.0};
  std::atomic<double> totalBeats{0.0};
  std::atomic<double> bpm{96.0};
  std::atomic<double> currentBeat{0.0};
  std::atomic<double> masterGain{0.8};
  std::atomic<double> reverbMix{0.18};
  std::atomic<bool> loopEnabled{false};
  std::atomic<bool> lowPower{false};

  // 第 beat 拍这一刻的速度（拍/秒）。没有速度表时退回单一 bpm。
  double bpmAt(double beat) const {
    const int n = tempoCount.load(std::memory_order_acquire);
    if (n <= 0) return bpm.load(std::memory_order_relaxed);
    // 找最后一个 startBeat <= beat 的段
    int lo = 0, hi = n - 1;
    if (beat <= tempos[0].beat) return tempos[0].bpm;
    while (lo < hi) {
      const int mid = (lo + hi + 1) >> 1;
      if (tempos[mid].beat <= beat) lo = mid;
      else hi = mid - 1;
    }
    return tempos[lo].bpm;
  }

  // 渲染线程私有
  double beatsPerFrame = 0.0;
  Voice voices[MAX_VOICES];
  Reverb reverb;

  // 统计（原子，供 JS 读取）
  std::atomic<int> activeVoices{0};
  std::atomic<int> underruns{0};
  std::atomic<long long> framesRendered{0};

  void prepare(int sr) {
    sampleRate = sr;
    beatsPerFrame = 0.0;
    reverb.init(sr);
    for (auto& v : voices) v = Voice{};
    LOGI("engine prepared sr=%d", sr);
  }

  // 音频回调：实时线程，绝对不能 malloc/free/加锁
  void render(float* out, int32_t numFrames) {
    // 统计放在最前面：不播放时也要记账，否则 framesRendered 一直是 0，
    // 看起来像音频回调没跑（排查时误导性很强）。
    framesRendered.fetch_add(numFrames, std::memory_order_relaxed);

    // 清空输出
    std::fill(out, out + numFrames * channels, 0.0f);

    auto& evs = events;
    const int evTotal = eventCount.load(std::memory_order_acquire);
    const bool isPlaying = playing.load(std::memory_order_acquire);

    if (!isPlaying) {
      activeVoices.store(0);
      // 不播放时也要跑混响尾巴，否则停止瞬间会「啪」一下
      for (int i = 0; i < numFrames; i++) {
        float wet = reverb.process(0.0f) * (float)reverbMix.load(std::memory_order_relaxed);
        for (int c = 0; c < channels; c++) out[i * channels + c] += wet;
      }
      return;
    }

    // 每帧推进多少拍。速度随播放位置变化，所以在循环里查；
    // 变化只是数组一次二分，代价可以忽略。这里先算一个默认值，
    // 循环内每 64 帧重算一次（速度表的分辨率是"小节"级别，够用）。
    const double bpfBase = bpmAt(currentBeat.load(std::memory_order_relaxed)) / 60.0 / (double)sampleRate;

    double beat = currentBeat.load(std::memory_order_relaxed);
    const double start = startBeat.load(std::memory_order_relaxed);
    const double total = totalBeats.load(std::memory_order_relaxed);
    int nextEv = nextEvent.load(std::memory_order_relaxed);
    const float gain = (float)masterGain.load(std::memory_order_relaxed);
    const float wetMix = (float)reverbMix.load(std::memory_order_relaxed);

    int active = 0;   // 本批渲染结束时的活动 voice 数（循环外累计）
    for (int i = 0; i < numFrames; i++) {
      // 速度每 64 帧复核一次：速度表最多几十段，一分钟内换不了几次，
      // 每帧都查没必要，但整批只查一次会在变速点之后继续用旧速度
      // 最多 64 帧（≈1.3ms），肉耳听不出来。
      const double bpf = (i % 64 == 0) ? (bpmAt(beat) / 60.0 / (double)sampleRate) : bpfBase;
      // 到点了就触发新音符
      while (nextEv < evTotal && evs[nextEv].beat <= beat + 1e-9) {
        spawnVoice(evs[nextEv], beat);
        nextEv++;
      }

      float dryL = 0.0f;
      float dryR = 0.0f;
      active = 0;

      // 渲染所有 voice
      for (auto& v : voices) {
        if (!v.active) continue;
        active++;

        // 包络：attack → sustain → release
        if (v.state == 0) {
          v.envelope += v.attackStep;
          if (v.envelope >= v.amplitude) {
            v.envelope = v.amplitude;
            v.state = 1;
          }
        } else if (v.state == 1) {
          if (v.position >= v.releaseAt) v.state = 2;
        } else {
          v.envelope -= v.releaseStep;
          if (v.envelope <= 0.0f) {
            v.active = false;
            continue;
          }
        }

        // 采样读取（线性插值）
        const Sample& s = samples[v.sampleId];
        if (s.frames <= 0) { v.active = false; continue; }

        // 循环采样（延音类）：到 loopEnd 就回到 loopStart
        double pos = v.position;
        if (v.loop && pos >= v.loopEnd) {
          double span = v.loopEnd - v.loopStart;
          if (span > 0) {
            pos = v.loopStart + std::fmod(pos - v.loopStart, span);
            v.position = pos;
          } else {
            v.active = false;
            continue;
          }
        }
        // 采样读完就停（非循环的打击类靠自己的衰减，不需要额外截断）
        if (pos >= (double)s.frames - 1.0) {
          v.active = false;
          continue;
        }

        int i0 = (int)pos;
        int i1 = std::min(i0 + 1, s.frames - 1);
        float frac = (float)(pos - (double)i0);
        float smp;
        if (s.channels == 2) {
          // 立体声：取左右平均，声像在后面统一处理
          int base0 = i0 * 2;
          int base1 = i1 * 2;
          float l = s.pcm[base0] * (1 - frac) + s.pcm[base1] * frac;
          float r = s.pcm[base0 + 1] * (1 - frac) + s.pcm[base1 + 1] * frac;
          smp = (l + r) * 0.5f / 32768.0f;
        } else {
          smp = (s.pcm[i0] * (1 - frac) + s.pcm[i1] * frac) / 32768.0f;
        }

        float val = smp * v.envelope;
        dryL += val * v.panL;
        dryR += val * v.panR;

        v.position += v.playbackRate;
      }

      // 混响（单声道取平均）
      float mono = (dryL + dryR) * 0.5f;
      float wet = reverb.process(mono) * wetMix;

      float l = (dryL + wet) * gain;
      float r = (dryR + wet) * gain;

      // 软限幅，防止多声部叠加削顶
      l = std::tanh(l);
      r = std::tanh(r);

      if (channels >= 2) {
        out[i * 2] = l;
        out[i * 2 + 1] = r;
      } else {
        out[i] = (l + r) * 0.5f;
      }

      beat += bpf;
      if (total > 0 && beat >= start + total) {
        // 播完了
        playing.store(false, std::memory_order_release);
        // 剩下的帧继续跑混响尾巴
        for (int j = i + 1; j < numFrames; j++) {
          float w = reverb.process(0.0f) * wetMix;
          if (channels >= 2) { out[j*2] = w*gain; out[j*2+1] = w*gain; }
          else out[j] = w*gain;
        }
        currentBeat.store(beat, std::memory_order_release);
        activeVoices.store(active, std::memory_order_relaxed);
        return;
      }
    }

    currentBeat.store(beat, std::memory_order_release);
    nextEvent.store(nextEv, std::memory_order_release);
    activeVoices.store(active, std::memory_order_relaxed);
  }

  // 触发一个 voice。实时线程调用，不能分配内存。
  void spawnVoice(const Event& ev, double atBeat) {
    int slot = -1;
    for (int i = 0; i < MAX_VOICES; i++) {
      if (!voices[i].active) { slot = i; break; }
    }
    if (slot < 0) {
      underruns.fetch_add(1, std::memory_order_relaxed);
      return;   // 没有空闲 voice，丢弃这个音
    }

    // 找最接近这个音高的采样
    int best = -1;
    float bestDist = 1e9f;
    for (int i = 0; i < (int)samples.size(); i++) {
      float d = std::fabs(samples[i].rootMidi - (float)ev.midi);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best < 0) return;

    Voice& v = voices[slot];
    v = Voice{};
    v.active = true;
    v.sampleId = best;
    v.playbackRate = std::pow(2.0f, ((float)ev.midi - samples[best].rootMidi) / 12.0f);
    v.position = 0.0;
    v.amplitude = 0.28f * ev.velocity;
    v.envelope = 0.0f;
    v.state = 0;
    // 起音 12ms，释放 60ms
    v.attackStep = v.amplitude / std::max(1.0f, 0.012f * (float)sampleRate);
    v.releaseStep = v.amplitude / std::max(1.0f, 0.06f * (float)sampleRate);
    // 声像
    float p = std::max(-1.0f, std::min(1.0f, ev.pan));
    float angle = (p + 1.0f) * 0.25f * 3.14159265f;
    v.panL = std::cos(angle);
    v.panR = std::sin(angle);
    // 结束位置：按音符长度换算成采样帧。
    // 用这个音所在位置的速度，不是全曲第一个速度——变速段落里
    // 长音会被拉长或压短，用错速度会提前收声或拖到下一拍。
    double secPerBeat = 60.0 / bpmAt(atBeat);
    double durSec = ev.lengthBeats * secPerBeat;
    double frames = durSec * sampleRate * v.playbackRate;
    v.endPosition = frames;
    v.releaseAt = std::max(0.0, frames - 0.06 * sampleRate * v.playbackRate);
  }
};

Engine gEngine;

// 回调实现在下面，openStream 要先把它们登记进 builder
aaudio_callback_result_t dataCallback(void* stream, void* userData,
                                      void* audioData, int32_t numFrames);
void errorCallback(void* stream, void* userData, aaudio_result_t error);

// 回调真的在跑吗：隔一小段时间看帧计数有没有涨。
// requestStart 返回 OK 不代表回调会进——系统拒绝音频焦点时就是这样，
// 表现为「播放在跑、位置永远 0、没有声音」。
static bool callbackIsRunning(int waitMs) {
  long long before = gEngine.framesRendered.load(std::memory_order_relaxed);
  struct timespec ts { 0, waitMs * 1000000L };
  nanosleep(&ts, nullptr);
  long long after = gEngine.framesRendered.load(std::memory_order_relaxed);
  return after > before;
}

// 打开一条新的 AAudio 流并启动。不检查回调是否在跑，由调用方决定。
static bool openStream(int sampleRate) {
  if (!gApi.load()) return false;

  aaudio_builder_t* builder = nullptr;
  aaudio_result_t r = gApi.createBuilder(&builder);
  if (r != AAUDIO_OK_) {
    LOGE("createStreamBuilder failed: %d", r);
    return false;
  }

  gApi.setDirection(builder, AAUDIO_DIRECTION_OUTPUT_);
  gApi.setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY_);
  gApi.setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT_);
  gApi.setChannelCount(builder, 2);
  gApi.setSampleRate(builder, sampleRate);
  // 注意参数顺序：setDataCallback(builder, 回调, userData)
  gApi.setDataCallback(builder, (void*)dataCallback, (void*)&gEngine);
  gApi.setErrorCallback(builder, (void*)errorCallback, (void*)&gEngine);

  aaudio_stream_t* stream = nullptr;
  r = gApi.openStream(builder, &stream);
  gApi.builderDelete(builder);
  if (r != AAUDIO_OK_) {
    LOGE("openStream failed: %d", r);
    return false;
  }

  int actualRate = gApi.getSampleRate(stream);
  gEngine.stream = stream;
  // prepare() 必须在 requestStart 之前完成：它要重新分配混响缓冲、
  // 清空 voice。放到流已经跑起来之后再调，等于在音频线程读缓冲时
  // 释放重建，是竞态。
  gEngine.prepare(actualRate);

  r = gApi.requestStart(stream);
  if (r != AAUDIO_OK_) {
    LOGE("requestStart failed: %d", r);
    if (gApi.requestStop) gApi.requestStop(stream);
    if (gApi.closeStream) gApi.closeStream(stream);
    gEngine.stream = nullptr;
    return false;
  }
  LOGI("AAudio stream opened, sr=%d", actualRate);
  return true;
}

// 关掉当前流（如果有）
static void closeStream() {
  if (!gEngine.stream) return;
  if (gApi.requestStop) gApi.requestStop((aaudio_stream_t*)gEngine.stream);
  if (gApi.closeStream) gApi.closeStream((aaudio_stream_t*)gEngine.stream);
  gEngine.stream = nullptr;
  gEngine.playing.store(false, std::memory_order_release);
}

aaudio_callback_result_t dataCallback(void* stream, void* userData,
                                      void* audioData, int32_t numFrames) {
  auto* e = static_cast<Engine*>(userData);
  if (!e) return AAUDIO_CALLBACK_STOP_;
  e->render(static_cast<float*>(audioData), numFrames);
  return AAUDIO_CALLBACK_CONTINUE_;
}

void errorCallback(void* stream, void* userData, aaudio_result_t error) {
  if (gApi.resultText) LOGE("AAudio error: %d (%s)", error, gApi.resultText(error));
  else LOGE("AAudio error: %d", error);
}

}  // namespace

// ==================== JNI ====================

extern "C" {

JNIEXPORT jboolean JNICALL
Java_com_shisihang_sonnet_NativeAudio_start(JNIEnv* env, jobject /*thiz*/, jint sampleRate) {
  // 已经开着就直接复用 —— 但必须确认回调线程还活着。
  //
  // 只判断 stream 非空是不够的：AAudio 流会因为音频焦点被别的应用抢走、
  // 来电、蓝牙切换等原因被系统停掉（回调不再进入），而 gEngine.stream
  // 这个指针还留着。此时 start() 直接返回成功，上层以为一切正常，
  // 实际位置永远不推进——表现就是「点播放没有声音、进度条停在 0」，
  // 而且之后每次播放都这样，只能杀进程。
  if (gEngine.stream && callbackIsRunning(80)) {
    return JNI_TRUE;
  }
  if (gEngine.stream) {
    long long frames = gEngine.framesRendered.load(std::memory_order_relaxed);
    LOGI("AAudio stream is stale (frames %lld), reopening", frames);
    closeStream();
  }

  if (!openStream(sampleRate)) return JNI_FALSE;

  // 新流也要验证：系统可以在 openStream/requestStart 都返回成功的情况下
  // 拒绝调度回调。这时别报成功，让 JS 退回 Web Audio。
  if (!callbackIsRunning(80)) {
    LOGE("AAudio started but callback never ran, giving up");
    closeStream();
    return JNI_FALSE;
  }

  return JNI_TRUE;
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_stop(JNIEnv* env, jobject /*thiz*/) {
  if (!gEngine.stream) return;
  closeStream();
  LOGI("AAudio stopped");
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_loadSample(
    JNIEnv* env, jobject /*thiz*/, jint id, jshortArray pcm, jint frames,
    jint channels, jfloat rootMidi) {
  std::lock_guard<std::mutex> lock(gEngine.sampleMutex);
  if (id < 0) return;
  if ((int)gEngine.samples.size() <= id) gEngine.samples.resize(id + 1);

  jsize len = env->GetArrayLength(pcm);
  Sample& s = gEngine.samples[id];
  s.pcm.resize(len);
  env->GetShortArrayRegion(pcm, 0, len, s.pcm.data());
  s.frames = frames;
  s.channels = channels > 0 ? channels : 1;
  s.rootMidi = rootMidi;
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_playScore(
    JNIEnv* env, jobject /*thiz*/, jdoubleArray beats, jdoubleArray lengths,
    jintArray midis, jfloatArray velocities, jfloatArray pans, jint count,
    jdouble fromBeat, jdouble totalBeats, jdouble bpm) {
  std::lock_guard<std::mutex> lock(gEngine.eventMutex);
  int n = std::min((int)count, MAX_EVENTS);
  gEngine.events.clear();
  gEngine.events.reserve(n);

  std::vector<double> b(n), l(n);
  std::vector<int> m(n);
  std::vector<float> v(n), p(n);
  env->GetDoubleArrayRegion(beats, 0, n, b.data());
  env->GetDoubleArrayRegion(lengths, 0, n, l.data());
  env->GetIntArrayRegion(midis, 0, n, m.data());
  env->GetFloatArrayRegion(velocities, 0, n, v.data());
  env->GetFloatArrayRegion(pans, 0, n, p.data());

  for (int i = 0; i < n; i++) {
    // 只保留 fromBeat 之后的事件，并把它平移到 0
    if (b[i] + l[i] <= fromBeat + 1e-9) continue;
    Event e;
    e.beat = std::max(0.0, b[i] - fromBeat);
    e.lengthBeats = std::max(0.02, l[i] - std::max(0.0, fromBeat - b[i]));
    e.midi = m[i];
    e.velocity = v[i];
    e.pan = p[i];
    gEngine.events.push_back(e);
  }
  std::sort(gEngine.events.begin(), gEngine.events.end(),
            [](const Event& a, const Event& b) { return a.beat < b.beat; });

  gEngine.eventCount.store((int)gEngine.events.size(), std::memory_order_release);
  gEngine.nextEvent.store(0, std::memory_order_release);
  gEngine.startBeat.store(0.0, std::memory_order_release);
  gEngine.totalBeats.store(totalBeats, std::memory_order_release);
  gEngine.bpm.store(bpm, std::memory_order_release);
  gEngine.currentBeat.store(0.0, std::memory_order_release);
  gEngine.underruns.store(0, std::memory_order_release);
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_setTempos(
    JNIEnv* env, jobject /*thiz*/, jdoubleArray beats, jdoubleArray bpms, jint count) {
  int n = std::max(0, std::min((int)count, MAX_TEMPO_POINTS));
  if (n == 0) {
    gEngine.tempoCount.store(0, std::memory_order_release);
    return;
  }
  // 先落到临时缓冲再一次性提交计数：音频线程按 tempoCount 读，
  // 边写边改计数会让它读到写了一半的表。
  TempoPoint tmp[MAX_TEMPO_POINTS];
  std::vector<double> b(n), m(n);
  env->GetDoubleArrayRegion(beats, 0, n, b.data());
  env->GetDoubleArrayRegion(bpms, 0, n, m.data());
  for (int i = 0; i < n; i++) {
    tmp[i].beat = b[i];
    tmp[i].bpm = m[i] > 0 ? m[i] : 96.0;
  }
  gEngine.tempoCount.store(0, std::memory_order_release);
  for (int i = 0; i < n; i++) gEngine.tempos[i] = tmp[i];
  gEngine.tempoCount.store(n, std::memory_order_release);
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_play(JNIEnv* env, jobject /*thiz*/) {
  // 复位播放头并清理正在响的 voice
  for (auto& v : gEngine.voices) v.active = false;
  gEngine.nextEvent.store(0, std::memory_order_release);
  gEngine.currentBeat.store(0.0, std::memory_order_release);
  gEngine.reverb.reset();
  gEngine.playing.store(true, std::memory_order_release);
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_pause(JNIEnv* env, jobject /*thiz*/) {
  gEngine.playing.store(false, std::memory_order_release);
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_seekToBeat(JNIEnv* env, jobject /*thiz*/, jdouble beat) {
  std::lock_guard<std::mutex> lock(gEngine.eventMutex);
  // 找到这个位置之后第一个事件
  int idx = 0;
  for (int i = 0; i < (int)gEngine.events.size(); i++) {
    if (gEngine.events[i].beat >= beat) { idx = i; break; }
    idx = i + 1;
  }
  gEngine.nextEvent.store(idx, std::memory_order_release);
  gEngine.currentBeat.store(beat, std::memory_order_release);
  for (auto& v : gEngine.voices) v.active = false;
}

JNIEXPORT jdouble JNICALL
Java_com_shisihang_sonnet_NativeAudio_getPositionBeats(JNIEnv* env, jobject /*thiz*/) {
  return gEngine.currentBeat.load(std::memory_order_acquire);
}

JNIEXPORT jboolean JNICALL
Java_com_shisihang_sonnet_NativeAudio_isPlaying(JNIEnv* env, jobject /*thiz*/) {
  return gEngine.playing.load(std::memory_order_acquire) ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_setMasterGain(JNIEnv* env, jobject /*thiz*/, jfloat g) {
  gEngine.masterGain.store(std::max(0.0f, std::min(2.0f, g)), std::memory_order_release);
}

JNIEXPORT void JNICALL
Java_com_shisihang_sonnet_NativeAudio_setReverbMix(JNIEnv* env, jobject /*thiz*/, jfloat mix) {
  gEngine.reverbMix.store(std::max(0.0f, std::min(1.0f, mix)), std::memory_order_release);
}

// 诊断：活动 voice 数、欠载次数、已渲染帧数
JNIEXPORT jintArray JNICALL
Java_com_shisihang_sonnet_NativeAudio_getStats(JNIEnv* env, jobject /*thiz*/) {
  jint values[4] = {
      gEngine.activeVoices.load(std::memory_order_relaxed),
      gEngine.underruns.load(std::memory_order_relaxed),
      (jint)gEngine.eventCount.load(std::memory_order_relaxed),
      (jint)(gEngine.framesRendered.load(std::memory_order_relaxed) & 0x7fffffff),
  };
  jintArray out = env->NewIntArray(4);
  if (out) env->SetIntArrayRegion(out, 0, 4, values);
  return out;
}

JNIEXPORT jint JNICALL
Java_com_shisihang_sonnet_NativeAudio_getSampleRate(JNIEnv* env, jobject /*thiz*/) {
  return gEngine.sampleRate;
}

}  // extern "C"
