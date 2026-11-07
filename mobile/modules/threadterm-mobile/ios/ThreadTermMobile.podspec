Pod::Spec.new do |s|
  s.name           = 'ThreadTermMobile'
  s.version        = '0.1.0'
  s.summary        = 'ThreadTerm iPhone companion native client'
  s.description    = 'Pinned ThreadTerm transport, secure machine storage, biometric control and preview isolation.'
  s.homepage       = 'https://threadterm.local'
  s.license        = { :type => 'UNLICENSED' }
  s.author         = { 'ThreadTerm' => 'support@threadterm.local' }
  s.platforms      = { :ios => '17.0' }
  s.source         = { :git => 'https://threadterm.local/native.git', :tag => s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,mm,swift}', 'Generated/*.swift'
  s.vendored_frameworks = 'Frameworks/ThreadTermNativeFFI.xcframework'
  s.frameworks = 'Foundation', 'LocalAuthentication', 'Network', 'Security', 'UIKit', 'UniformTypeIdentifiers', 'WebKit'
  s.swift_version = '5.0'
  s.pod_target_xcconfig = {
    'IPHONEOS_DEPLOYMENT_TARGET' => '17.0',
    'DEFINES_MODULE' => 'YES'
  }
end
