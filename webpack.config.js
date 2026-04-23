const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    background: './src/background/index.ts',
    popup: './src/popup/popup.ts',
    'content/click-handler': './src/content/click-handler.ts',
    'content/drag-handler': './src/content/drag-handler.ts',
    'content/hover-handler': './src/content/hover-handler.ts',
    'content/input-handler': './src/content/input-handler.ts',
    'content/axe': './src/content/axe-entry.ts',
    'content/storage-monitor': './src/content/storage-monitor.ts',
    'content/macro-recorder': './src/content/macro-recorder.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: 'src/popup/popup.html', to: '.' },
        { from: 'src/popup/popup.css', to: '.' },

        { from: 'icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
  ],
  devtool: 'cheap-module-source-map',
  optimization: {
    minimize: false,
  },
};
