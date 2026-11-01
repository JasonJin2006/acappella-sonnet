package com.shisihang.sonnet;

/**
 * 原生音频引擎的 Java 桥。
 *
 * 之所以把音频放到原生层：
 * Web Audio 的节点创建、buffer 解码、排期都在 JS 主线程上跑。主线程一旦被
 * UI 绘制或 GC 占住，排期就晚于音频线程要 buffer 的时刻，手机上的表现是
 * 断续和爆音。专业音频软件全部把渲染放在实时优先级的原生线程里，
 * 和 UI 完全隔离，并且启动时预分配好 voice，播放过程中零分配。
 *
 * 这个类只是薄薄一层 JNI 转发，所有状态都在 C++ 侧（native_audio.cpp）。
 * 方法全部是 static，便于从 Capacitor 插件直接调用。
 */
public final class NativeAudio {

    private static boolean loaded = false;
    private static boolean available = false;

    static {
        try {
            System.loadLibrary("sonnetaudio");
            loaded = true;
            available = true;
        } catch (UnsatisfiedLinkError e) {
            // 老设备或构建时没带 native 库：调用方要能退回到 Web Audio
            loaded = false;
            available = false;
        }
    }

    private NativeAudio() {}

    /** 原生库是否可用。不可用时调用方应退回 Web Audio 实现。 */
    public static boolean isAvailable() {
        return available;
    }

    /** 启动 AAudio 流。sampleRate 传期望值，实际采样率用 getSampleRate() 读。 */
    public static native boolean start(int sampleRate);

    /** 停止并关闭音频流。 */
    public static native void stop();

    /**
     * 灌入一个采样。
     * @param id       采样编号（JS 侧维护映射）
     * @param pcm      16-bit PCM，立体声时交错存放
     * @param frames   帧数
     * @param channels 声道数（1 或 2）
     * @param rootMidi 这个采样本身的音高
     */
    public static native void loadSample(int id, short[] pcm, int frames, int channels, float rootMidi);

    /**
     * 灌入整首谱面。数组按事件下标一一对应，count 为事件数。
     * fromBeat 之后的事件才会被保留（用于从中间开始播）。
     */
    public static native void playScore(
            double[] beats, double[] lengths, int[] midis,
            float[] velocities, float[] pans, int count,
            double fromBeat, double totalBeats, double bpm);

    /** 从头开始播放（会复位播放头）。 */
    public static native void play();

    /** 暂停。 */
    public static native void pause();

    /** 跳到某一拍。 */
    public static native void seekToBeat(double beat);

    /** 当前播放到第几拍（相对 fromBeat）。 */
    public static native double getPositionBeats();

    /** 是否正在播放。 */
    public static native boolean isPlaying();

    public static native void setMasterGain(float gain);

    public static native void setReverbMix(float mix);

    /** 返回 { activeVoices, underruns, eventCount, framesRendered }。 */
    public static native int[] getStats();

    public static native int getSampleRate();
}
