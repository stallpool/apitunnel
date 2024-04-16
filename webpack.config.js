const path = require('path');

module.exports = [{
  target: 'node',
  mode: 'production',
  entry: './pub/index.js',
  optimization: {
    minimize: true,
  },
  output: {
    filename: 'pub.js',
    path: path.resolve(__dirname, 'dist'),
  },
}, {
  target: 'node',
  mode: 'production',
  entry: './sub/index.js',
  optimization: {
    minimize: true,
  },
  output: {
    filename: 'sub.js',
    path: path.resolve(__dirname, 'dist'),
  },
}];
