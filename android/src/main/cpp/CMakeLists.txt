# librangesource.so: the native reader and stores (native/src), their C table, and the Java API's
# JNI glue. CMAKE_CURRENT_SOURCE_DIR, not CMAKE_SOURCE_DIR, so that React Native's build can add
# this directory to its own.
cmake_minimum_required(VERSION 3.22.1)
project(rangesource CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(NATIVE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../native" ABSOLUTE)

add_library(rangesource SHARED
    ${NATIVE_DIR}/src/RangeReader.cpp
    ${NATIVE_DIR}/src/Store.cpp
    ${NATIVE_DIR}/src/range_source.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/range_source_jni.cpp
)
target_include_directories(rangesource PRIVATE ${NATIVE_DIR}/include ${NATIVE_DIR}/src)

# Only the JNI functions are exported; players get the table through RangeSource.plugin()
set_target_properties(rangesource PROPERTIES CXX_VISIBILITY_PRESET hidden VISIBILITY_INLINES_HIDDEN ON)

# Google Play requires 16 KB-aligned segments for Android 15+; NDK r27 and older link 4 KB by default.
target_link_options(rangesource PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,--gc-sections" "-Wl,--exclude-libs,ALL")
target_compile_options(rangesource PRIVATE -ffunction-sections -fdata-sections)

find_library(log-lib log)
target_link_libraries(rangesource ${log-lib})
