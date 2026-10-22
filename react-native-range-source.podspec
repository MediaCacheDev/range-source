# range-source for React Native on iOS, which autolinking finds in the npm package: the same
# sources as range-source.podspec. The players find it at runtime; there's nothing to call.

require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name                = 'react-native-range-source'
  s.module_name         = 'RangeSource'
  s.version             = package['version']
  s.summary             = package['description']
  s.homepage            = package['homepage']
  s.license             = package['license']
  s.authors             = package['author']
  s.platforms           = { :ios => '13.0' }
  s.source              = { :git => package['repository']['url'], :tag => "v#{s.version}" }

  s.source_files        = 'native/include/*.h', 'native/src/*.{h,cpp}', 'ios/Sources/RangeSource/**/*.{h,mm}'
  s.public_header_files = 'ios/Sources/RangeSource/include/*.h'
  s.libraries           = 'c++'
  # DEFINES_MODULE: Swift apps import RangeSource (RangeDataSources) without use_frameworks!
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/native/include" "$(PODS_TARGET_SRCROOT)/native/src"'
  }
end
