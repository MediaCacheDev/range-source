# Host build of the native range reader and stores, with their tests. The players compile src/
# into their own native libraries instead.
#
#   cmake -S native -B native/build -G Ninja && cmake --build native/build && native/build/source_tests
cmake_minimum_required(VERSION 3.20)
project(alpha_video_source CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(Threads REQUIRED)

add_library(alpha_video_source STATIC src/RangeReader.cpp src/Store.cpp)
target_include_directories(alpha_video_source PUBLIC src)
target_compile_options(alpha_video_source PRIVATE -Wall -Wextra)
target_link_libraries(alpha_video_source PUBLIC Threads::Threads)

add_executable(source_tests test/source_tests.cpp)
target_compile_options(source_tests PRIVATE -Wall)
target_link_libraries(source_tests PRIVATE alpha_video_source)
