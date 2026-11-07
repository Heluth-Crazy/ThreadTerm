const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const mobile = path.resolve(__dirname, '../..');
const root = path.resolve(mobile, '..');
const config = getDefaultConfig(__dirname);
config.watchFolders = [mobile, root];
config.resolver.nodeModulesPaths = [path.join(mobile, 'node_modules'), path.join(root, 'node_modules')];
// The desktop and Expo workspaces use different React versions. Every QA
// dependency must resolve React through the mobile workspace, including hoisted RNW.
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
