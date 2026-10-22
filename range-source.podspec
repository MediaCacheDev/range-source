# range-source for iOS, for CocoaPods: the native reader and stores with their Objective-C API.
# The players' Source subspecs depend on it. (React Native apps use
# react-native-range-source.podspec, which autolinking finds in the npm package.)
#
# 1.0.0 goes on CocoaPods trunk, which is read-only from 2 December 2026. Later versions are used
# through the podspec at their tag:
#   pod 'range-source', :podspec => 'https://raw.githubusercontent.com/MediaCacheDev/range-source/v<version>/range-source.podspec'

Pod::Spec.new do |s|
  s.name                = 'range-source'
  s.module_name         = 'RangeSource'
  s.version             = '1.0.0'
  s.summary             = 'Reads files by offset from URLs or app data sources: range requests, read-ahead, retries, and storage on disk or in memory.'
  s.homepage            = 'https://github.com/MediaCacheDev/range-source'
  s.license             = { :type => 'MIT', :file => 'LICENSE' }
  s.author              = { 'Daniel Kasprowicz' => '9932671+danielkpl2@users.noreply.github.com' }
  s.platform            = :ios, '13.0'
  s.source              = { :git => 'https://github.com/MediaCacheDev/range-source.git', :tag => "v#{s.version}" }

  s.source_files        = 'native/include/*.h', 'native/src/*.{h,cpp}', 'ios/Sources/RangeSource/**/*.{h,mm}'
  s.public_header_files = 'ios/Sources/RangeSource/include/*.h'
  s.libraries           = 'c++'
  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/native/include" "$(PODS_TARGET_SRCROOT)/native/src"'
  }
end
