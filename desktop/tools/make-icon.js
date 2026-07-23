'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const desktopRoot = path.resolve(__dirname, '..');
const source = path.resolve(desktopRoot, '..', '..', 'outputs', 'bioassay-studio', 'icon.svg');
const outputDir = path.join(desktopRoot, 'build');
const output = path.join(outputDir, 'icon.png');

fs.mkdirSync(outputDir, { recursive: true });
sharp(source, { density: 384 })
  .resize(512, 512)
  .png()
  .toFile(output)
  .then(() => console.log(`Created ${output}`))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

