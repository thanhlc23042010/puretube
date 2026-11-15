Pod::Spec.new do |s|
  s.name = 'PuretubeNative'
  s.version = '1.0.0'
  s.summary = 'PureTube CORS-free native HTTP bridge'
  s.license = 'MIT'
  s.homepage = 'https://puretube.local'
  s.author = 'PureTube'
  s.source = { :path => '.' }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
