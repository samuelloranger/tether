const { withXcodeProject, withEntitlementsPlist, withDangerousMod } = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

// Expo has no first-party way to add a Notification Service Extension target,
// and `expo prebuild --clean` regenerates ios/ every run, so the target has to
// be re-created on each prebuild rather than committed.
//
// The extension exists to decrypt push payloads on-device. It reads the AES key
// expo-secure-store wrote in the app, which is only possible if both binaries
// share a keychain access group — hence the entitlement on BOTH targets.
const TARGET_NAME = 'TetherNotificationService';
const SOURCE_DIR = 'ios-nse';

/** The shared keychain group. $(AppIdentifierPrefix) expands to the team id. */
const keychainGroup = (bundleId) => `$(AppIdentifierPrefix)${bundleId}`;

/** Copy the Swift source, Info.plist and entitlements into the generated project. */
const withExtensionFiles = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const iosRoot = cfg.modRequest.platformProjectRoot;
      const from = path.join(projectRoot, SOURCE_DIR);
      const to = path.join(iosRoot, TARGET_NAME);
      fs.mkdirSync(to, { recursive: true });

      fs.copyFileSync(
        path.join(from, 'NotificationService.swift'),
        path.join(to, 'NotificationService.swift'),
      );
      fs.copyFileSync(path.join(from, 'Info.plist'), path.join(to, 'Info.plist'));

      fs.writeFileSync(
        path.join(to, `${TARGET_NAME}.entitlements`),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>keychain-access-groups</key>
  <array>
    <string>${keychainGroup(cfg.ios.bundleIdentifier)}</string>
  </array>
</dict>
</plist>
`,
      );
      return cfg;
    },
  ]);

/** The app itself must join the same keychain group, or it writes a key the extension cannot read. */
const withAppKeychainGroup = (config) =>
  withEntitlementsPlist(config, (cfg) => {
    const group = keychainGroup(cfg.ios.bundleIdentifier);
    const existing = cfg.modResults['keychain-access-groups'] ?? [];
    if (!existing.includes(group)) {
      cfg.modResults['keychain-access-groups'] = [...existing, group];
    }
    return cfg;
  });

/** Create the PBXNativeTarget and wire it into the app's embed phase. */
const withExtensionTarget = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const bundleId = `${cfg.ios.bundleIdentifier}.${TARGET_NAME}`;

    // Idempotent: prebuild may run against an existing project.
    if (project.pbxTargetByName(TARGET_NAME)) return cfg;

    const groupKey = project.pbxCreateGroup(TARGET_NAME, TARGET_NAME);
    const target = project.addTarget(TARGET_NAME, 'app_extension', TARGET_NAME, bundleId);

    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    project.addBuildPhase(
      ['UserNotifications.framework'],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid,
    );

    project.addSourceFile(
      `${TARGET_NAME}/NotificationService.swift`,
      { target: target.uuid },
      groupKey,
    );
    project.addFile(`${TARGET_NAME}/Info.plist`, groupKey);

    // Without an explicit dependency Xcode has no guaranteed build order, so the
    // app's "Copy Files" phase can run before the .appex exists and the archive
    // fails with a missing-product error. addTarget wires the copy phase but not
    // the dependency.
    //
    // addTargetDependency silently does nothing when the PBXTargetDependency and
    // PBXContainerItemProxy sections are absent — it guards on both existing and
    // returns normally either way. A freshly prebuilt Expo project has neither,
    // so these must be created first or the dependency is quietly dropped.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};
    const appTarget = project.getFirstTarget();
    project.addTargetDependency(appTarget.uuid, [target.uuid]);

    // Swift in an extension needs an explicit version and the entitlements path;
    // without SWIFT_VERSION the target fails to compile with an opaque error.
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const buildSettings = configurations[key].buildSettings;
      if (!buildSettings || buildSettings.PRODUCT_NAME !== `"${TARGET_NAME}"`) continue;
      // Expo writes MARKETING_VERSION / CURRENT_PROJECT_VERSION onto the APP
      // target only; a sibling extension target inherits neither. The
      // extension's Info.plist references both, so without these they expand to
      // empty and App Store validation rejects the upload for missing or
      // mismatched bundle versions. CI rewrites app.json before prebuild, so
      // these read the same values the app itself is built with.
      buildSettings.MARKETING_VERSION = `"${cfg.version}"`;
      buildSettings.CURRENT_PROJECT_VERSION = `"${cfg.ios?.buildNumber ?? '1'}"`;
      buildSettings.SWIFT_VERSION = '5.0';
      buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
      buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '"16.0"';
      buildSettings.CODE_SIGN_ENTITLEMENTS = `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`;
      buildSettings.INFOPLIST_FILE = `"${TARGET_NAME}/Info.plist"`;
      buildSettings.CODE_SIGN_STYLE = 'Automatic';
    }

    return cfg;
  });

module.exports = (config) =>
  withExtensionTarget(withAppKeychainGroup(withExtensionFiles(config)));
