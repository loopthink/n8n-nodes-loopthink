const { src, dest } = require('gulp');

// n8n loads node icons from dist alongside the compiled JS; tsc does not copy
// non-TS files, so they are moved here after the build.
function buildIcons() {
	return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

exports['build:icons'] = buildIcons;
