#!/usr/bin/env node
import { ReleasePackagerCli } from '../dist/cli/release-packager-cli.js';

ReleasePackagerCli.run(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
);
