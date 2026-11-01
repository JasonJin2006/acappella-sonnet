cmake_minimum_required(VERSION 3.22.1)
project(sonnetaudio LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(sonnetaudio SHARED native_audio.cpp)

# 不静态链接 libaaudio：应用 minSdk 是 24，而 libaaudio.so 从 API 26 才有。
# 直接在链接期写 -laaudio 会让整个 APK 在 24/25 设备上装不上或启动即崩。
#
# 改成：运行时用 dlopen("libaaudio.so") 拿符号（见 native_audio.cpp 的
# AAudioApi 结构）。这样：
#   - 编译期不需要 libaaudio.so，链接干净
#   - 24/25 设备上 dlopen 失败，start() 返回 false，Java 侧退回 Web Audio
#   - 26+ 设备正常使用低延迟 AAudio
target_link_libraries(sonnetaudio
        android
        log
        dl)

target_compile_options(sonnetaudio PRIVATE -O3 -ffast-math -fno-exceptions -fno-rtti)
