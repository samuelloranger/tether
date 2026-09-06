# Adds a UI test bundle target (TetherIOSUITests) to Tether.xcodeproj and wires
# it into the shared TetherIOS scheme so `xcodebuild test -scheme TetherIOS` runs it.
# Idempotent: re-running removes and recreates the target cleanly.
require 'xcodeproj'

proj_path = ARGV.fetch(0)
proj = Xcodeproj::Project.open(proj_path)

APP = 'TetherIOS'
TEST = 'TetherIOSUITests'

app = proj.targets.find { |t| t.name == APP } or abort "no #{APP} target"

# clean slate if re-run
proj.targets.select { |t| t.name == TEST }.each(&:remove_from_project)
if (g = proj.main_group[TEST]); g.remove_from_project; end

test = proj.new_target(:ui_test_bundle, TEST, :ios, '17.0')

group = proj.main_group.new_group(TEST, TEST)
# Compile every .swift in the TetherIOSUITests dir so new test files are picked
# up without editing this script.
Dir.glob(File.join(File.dirname(proj_path), TEST, '*.swift')).sort.each do |f|
  test.add_file_references([group.new_file(File.basename(f))])
end

test.build_configurations.each do |c|
  bs = c.build_settings
  bs['PRODUCT_NAME'] = '$(TARGET_NAME)'
  bs['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.samuelloranger.tether-mobile.uitests'
  bs['GENERATE_INFOPLIST_FILE'] = 'YES'
  bs['TEST_TARGET_NAME'] = APP
  bs['CODE_SIGNING_ALLOWED'] = 'NO'
  bs['CODE_SIGNING_REQUIRED'] = 'NO'
  bs['SWIFT_VERSION'] = '5.0'
  bs['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'
  bs['TARGETED_DEVICE_FAMILY'] = '1,2'
  bs['SWIFT_EMIT_LOC_STRINGS'] = 'NO'
end

test.add_dependency(app)
proj.save

# wire into the shared scheme (create/repair as needed)
scheme_dir = Xcodeproj::XCScheme.shared_data_dir(proj_path)
scheme_path = File.join(scheme_dir.to_s, "#{APP}.xcscheme")
scheme = File.exist?(scheme_path) ? Xcodeproj::XCScheme.new(scheme_path) : Xcodeproj::XCScheme.new
unless scheme.build_action.entries.any? { |e| e.buildable_references.any? { |r| r.target_name == APP } }
  scheme.add_build_target(app)
end
scheme.add_test_target(test)
scheme.set_launch_target(app) rescue nil
FileUtils.mkdir_p(scheme_dir.to_s)
scheme.save_as(proj_path, APP, true)

puts "OK: added #{TEST}, wired into #{APP} scheme"
