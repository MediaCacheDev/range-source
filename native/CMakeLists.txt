# Host build of the native range reader and stores, with their tests: once on the C++ classes,
# once through the C table in include/range_source.h.
#
#   cmake -S native -B native/build -G Ninja && cmake --build native/build && ctest --test-dir native/build
cmake_minimum_required(VERSION 3.20)
project(range_source C CXX)

set(CMAKE_C_STANDARD 99)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(Threads REQUIRED)

add_library(range_source STATIC src/RangeReader.cpp src/Store.cpp src/range_source.cpp)
target_include_directories(range_source PUBLIC src include)
target_compile_options(range_source PRIVATE -Wall -Wextra)
target_link_libraries(range_source PUBLIC Threads::Threads)

enable_testing()

add_executable(range_source_tests test/source_tests.cpp)
target_compile_options(range_source_tests PRIVATE -Wall)
target_link_libraries(range_source_tests PRIVATE range_source)
add_test(NAME range_source_tests COMMAND range_source_tests)

add_executable(range_source_abi_tests test/source_tests.cpp test/c_tests.c)
target_compile_definitions(range_source_abi_tests PRIVATE RANGE_SOURCE_TESTS_THROUGH_ABI)
target_compile_options(range_source_abi_tests PRIVATE -Wall)
target_link_libraries(range_source_abi_tests PRIVATE range_source)
add_test(NAME range_source_abi_tests COMMAND range_source_abi_tests)
