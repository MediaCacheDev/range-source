module.exports = {
  dependency: {
    platforms: {
      ios: {},
      android: {
        sourceDir: './react-native/android',
        packageImportPath: 'import dev.mediacache.rangesource.reactnative.RangeSourcePackage;',
        packageInstance: 'new RangeSourcePackage()',
      },
    },
  },
};
