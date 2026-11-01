package com.shisihang.sonnet;

import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;

/**
 * 原生音频引擎的 Capacitor 插件。
 *
 * JS 侧通过 Capacitor.Plugins.NativeAudio 调用。
 * 所有方法都返回 Promise（Capacitor 自动包装）。
 *
 * 设计原则：JS 只在「开始播放」时把整首谱面的音符一次性灌进来，
 * 之后渲染完全在原生线程跑，JS 只轮询播放位置。这样主线程卡顿
 * 不会影响声音——这正是专业音频软件的做法。
 */
@CapacitorPlugin(name = "NativeAudio")
public class NativeAudioPlugin extends Plugin {

    private static final String TAG = "NativeAudioPlugin";

    // 采样解码用的后台线程池。单线程足够：采样是一个接一个上传的，
    // 多线程也快不了，还多占内存。守护线程避免拖住进程退出。
    private final java.util.concurrent.ExecutorService ioExecutor =
        java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "sonnet-audio-decode");
            t.setDaemon(true);
            return t;
        });

    /** 原生引擎是否可用（API 26+ 且 so 加载成功）。 */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        boolean ok = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && NativeAudio.isAvailable();
        ret.put("available", ok);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("AAudio requires API 26+");
            return;
        }
        int sr = call.getInt("sampleRate", 48000);
        // start() 内部会停 80ms 左右验证回调是否真的在跑（见 native_audio.cpp），
        // 放主线程会卡住 UI，挪到后台线程。Capacitor 的 resolve 可以在任意线程调用。
        ioExecutor.execute(() -> {
            boolean ok = NativeAudio.start(sr);
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            ret.put("sampleRate", ok ? NativeAudio.getSampleRate() : 0);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ioExecutor.execute(() -> {
            NativeAudio.stop();
            call.resolve();
        });
    }

    /**
     * 灌入一个采样。pcm 传 base64 编码的 16-bit 小端 PCM。
     * 用 base64 而不是数组，是因为 Capacitor 的 JSON 桥对大数组很慢。
     *
     * 解码和样本转换必须放到后台线程：一首多声部谱首次播放要上传
     * 二三十个采样、两千万个样本，全在主线程跑会让 WebView 掉到
     * 20fps（实测每次 200~500ms，累计 8 秒）。Capacitor 的
     * resolve/reject 可以在任意线程调用，它会自己切回主线程。
     */
    @PluginMethod
    public void loadSample(PluginCall call) {
        Integer id = call.getInt("id");
        String b64 = call.getString("pcm");
        Integer frames = call.getInt("frames");
        Integer channels = call.getInt("channels", 1);
        Double rootMidi = call.getDouble("rootMidi", 60.0);
        if (id == null || b64 == null || frames == null) {
            call.reject("id / pcm / frames required");
            return;
        }
        final int fId = id;
        final int fFrames = frames;
        final int fChannels = channels;
        final float fRoot = rootMidi == null ? 60f : rootMidi.floatValue();
        ioExecutor.execute(() -> {
            try {
                byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
                int count = bytes.length / 2;
                short[] pcm = new short[count];
                // 手工拼小端 16-bit：不用 ByteBuffer 是为了避开额外分配
                for (int i = 0; i < count; i++) {
                    int lo = bytes[i * 2] & 0xff;
                    int hi = bytes[i * 2 + 1] & 0xff;
                    pcm[i] = (short) ((hi << 8) | lo);
                }
                NativeAudio.loadSample(fId, pcm, fFrames, fChannels, fRoot);
                call.resolve();
            } catch (Exception e) {
                call.reject("loadSample failed: " + e.getMessage());
            }
        });
    }

    /**
     * 灌入整首谱面。五个数组等长，按事件下标对应。
     */
    @PluginMethod
    public void playScore(PluginCall call) {
        try {
            JSArray beatsA = call.getArray("beats");
            JSArray lengthsA = call.getArray("lengths");
            JSArray midisA = call.getArray("midis");
            JSArray velsA = call.getArray("velocities");
            JSArray pansA = call.getArray("pans");
            if (beatsA == null || lengthsA == null || midisA == null || velsA == null || pansA == null) {
                call.reject("beats/lengths/midis/velocities/pans required");
                return;
            }
            int n = beatsA.length();
            double[] beats = new double[n];
            double[] lengths = new double[n];
            int[] midis = new int[n];
            float[] vels = new float[n];
            float[] pans = new float[n];
            for (int i = 0; i < n; i++) {
                beats[i] = beatsA.getDouble(i);
                lengths[i] = lengthsA.getDouble(i);
                midis[i] = midisA.getInt(i);
                vels[i] = (float) velsA.getDouble(i);
                pans[i] = (float) pansA.getDouble(i);
            }
            double fromBeat = call.getDouble("fromBeat", 0.0);
            double totalBeats = call.getDouble("totalBeats", 0.0);
            double bpm = call.getDouble("bpm", 96.0);
            NativeAudio.playScore(beats, lengths, midis, vels, pans, n, fromBeat, totalBeats, bpm);
            JSObject ret = new JSObject();
            ret.put("events", n);
            call.resolve(ret);
        } catch (JSONException e) {
            call.reject("playScore failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setTempos(PluginCall call) {
        try {
            JSArray beatsA = call.getArray("beats");
            JSArray bpmsA = call.getArray("bpms");
            if (beatsA == null || bpmsA == null) {
                call.reject("beats/bpms required");
                return;
            }
            int n = Math.min(beatsA.length(), bpmsA.length());
            double[] beats = new double[n];
            double[] bpms = new double[n];
            for (int i = 0; i < n; i++) {
                beats[i] = beatsA.getDouble(i);
                bpms[i] = bpmsA.getDouble(i);
            }
            NativeAudio.setTempos(beats, bpms, n);
            JSObject ret = new JSObject();
            ret.put("count", n);
            call.resolve(ret);
        } catch (JSONException e) {
            call.reject("setTempos failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        NativeAudio.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        NativeAudio.pause();
        call.resolve();
    }

    @PluginMethod
    public void seekToBeat(PluginCall call) {
        Double beat = call.getDouble("beat", 0.0);
        NativeAudio.seekToBeat(beat);
        call.resolve();
    }

    @PluginMethod
    public void getPositionBeats(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("beat", NativeAudio.getPositionBeats());
        ret.put("playing", NativeAudio.isPlaying());
        call.resolve(ret);
    }

    @PluginMethod
    public void setMasterGain(PluginCall call) {
        Double g = call.getDouble("gain", 0.8);
        NativeAudio.setMasterGain(g.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setReverbMix(PluginCall call) {
        Double m = call.getDouble("mix", 0.18);
        NativeAudio.setReverbMix(m.floatValue());
        call.resolve();
    }

    /** 诊断：活动 voice、欠载次数、事件数、已渲染帧。 */
    @PluginMethod
    public void getStats(PluginCall call) {
        int[] s = NativeAudio.getStats();
        JSObject ret = new JSObject();
        if (s != null && s.length >= 4) {
            ret.put("activeVoices", s[0]);
            ret.put("underruns", s[1]);
            ret.put("eventCount", s[2]);
            ret.put("framesRendered", s[3]);
            ret.put("sampleRate", NativeAudio.getSampleRate());
        }
        call.resolve(ret);
    }
}
