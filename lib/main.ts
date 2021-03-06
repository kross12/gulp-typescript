///<reference path='../definitions/ref.d.ts'/>

import ts = require('typescript');
import gutil = require('gulp-util');
import path = require('path');
import stream = require('stream');
import project = require('./project');
import _filter = require('./filter');
import _reporter = require('./reporter');
import through2 = require('through2');

var PLUGIN_NAME = 'gulp-typescript';

class CompileStream extends stream.Duplex {
	constructor(proj: project.Project, theReporter: _reporter.Reporter = _reporter.defaultReporter()) {
		super({objectMode: true});

		this._project = proj;
		this.reporter = theReporter;

		// Backwards compatibility
		this.js = this;

		// Prevent "Unhandled stream error in pipe" when compilation error occurs.
		this.on('error', () => {});
	}

	private reporter: _reporter.Reporter;

	private _project: project.Project;
	private _hasSources: boolean = false;

	_write(file: gutil.File, encoding, cb = (err?) => {}) {
		if (!file) return cb();

		if (file.isNull()) {
			cb();
			return;
		}
		if (file.isStream()) {
			return cb(new gutil.PluginError(PLUGIN_NAME, 'Streaming not supported'));
		}

		this._hasSources = true;
		this._project.addFile(file);
		cb();
	}
	_read() {

	}

	private compile() {
		if (!this._hasSources) {
			this.js.push(null);
			this.dts.push(null);
			return;
		}

		// Try to re-use the output of the previous build. If that fails, start normal compilation.
		if (this._project.lazyCompile(this.js, this.dts)) {
			this.js.push(null);
			this.dts.push(null);
		} else {
			this._project.resolveAll(() => {
				this._project.compile(this.js, this.dts, (err) => {
					if (this.reporter.error) this.reporter.error(err, this._project.typescript);

					this.emit('error', new gutil.PluginError(PLUGIN_NAME, err.message));
				});
				this.js.push(null);
				this.dts.push(null);
			});
		}
	}

	end(chunk?, encoding?, callback?) {
		this._write(chunk, encoding, callback);
		this.compile();
	}

	js: stream.Readable;
	dts: stream.Readable = new CompileOutputStream();
}
class CompileOutputStream extends stream.Readable {
	constructor() {
		super({objectMode: true});
	}

	_read() {

	}
}

function compile();
function compile(proj: project.Project, filters?: compile.FilterSettings, theReporter?: _reporter.Reporter);
function compile(settings: compile.Settings, filters?: compile.FilterSettings, theReporter?: _reporter.Reporter);
function compile(param?: any, filters?: compile.FilterSettings, theReporter?: _reporter.Reporter): any {
	var proj: project.Project;
	if (param instanceof project.Project) {
		proj = param;
	} else {
		proj = new project.Project(getCompilerOptions(param || {}), (param && param.noExternalResolve) || false, (param && param.sortOutput) || false, (param && param.typescript) || undefined);
	}

	proj.reset();
	proj.filterSettings = filters;

	var inputStream = new CompileStream(proj, theReporter);

	return inputStream;
}

var langMap: project.Map<ts.ScriptTarget> = {
	'es3': ts.ScriptTarget.ES3,
	'es5': ts.ScriptTarget.ES5,
	'es6': ts.ScriptTarget.ES6
}
var moduleMap: project.Map<ts.ModuleKind> = {
	'commonjs': ts.ModuleKind.CommonJS,
	'amd': ts.ModuleKind.AMD,
	'none': ts.ModuleKind.None
}

function getCompilerOptions(settings: compile.Settings): ts.CompilerOptions {
	var tsSettings: ts.CompilerOptions = {};

	for (var key in settings) {
		if (!Object.hasOwnProperty.call(settings, key)) continue;
		if (key === 'outDir' ||
			key === 'noExternalResolve' ||
			key === 'declarationFiles' ||
			key === 'sortOutput' ||
			key === 'typescript' ||
			key === 'target' || // Target, module & sourceRoot are added below
			key === 'module' ||
			key === 'sourceRoot') continue;

		tsSettings[key] = settings[key];
	}

	if (typeof settings.target === 'string') {
		tsSettings.target = langMap[(<string> settings.target).toLowerCase()];
	} else if (typeof settings.target === 'number') {
		tsSettings.target = <number> settings.target;
	}
	if (typeof settings.module === 'string') {
		tsSettings.module = moduleMap[(<string> settings.module).toLowerCase()];
	} else if (typeof settings.module === 'number') {
		tsSettings.module = <number> settings.module;
	}

	if (tsSettings.target === undefined) {
		// TS 1.4 has a bug that the target needs to be set.
		// This block can be removed when a version that solves this bug is published.
		// The bug is already fixed in the master of TypeScript
		tsSettings.target = ts.ScriptTarget.ES3;
	}
	if (tsSettings.module === undefined) {
		// Same bug in TS 1.4 as previous comment.
		tsSettings.module = ts.ModuleKind.None;
	}

	if (settings.sourceRoot === undefined) {
		tsSettings.sourceRoot = process.cwd();
	} else {
		tsSettings.sourceRoot = settings.sourceRoot;
	}

	if (settings.declarationFiles !== undefined) {
		tsSettings.declaration = settings.declarationFiles;
	}

	tsSettings.sourceMap = true;

	return tsSettings;
}

module compile {
	export interface Settings {
		out?: string;

		allowNonTsExtensions?: boolean;
		charset?: string;
		codepage?: number;
		declaration?: boolean; // alias of declarationFiles
		locale?: string;
		mapRoot?: string;
		noEmitOnError?: boolean;
		noImplicitAny?: boolean;
		noLib?: boolean;
		noLibCheck?: boolean;
		noResolve?: boolean;
		preserveConstEnums?: boolean;
		removeComments?: boolean;
		sourceRoot?: string;
		suppressImplicitAnyIndexErrors?: boolean;

		target: string | ts.ScriptTarget;
		module: string | ts.ModuleKind;

		declarationFiles?: boolean;

		noExternalResolve?: boolean;
		sortOutput?: boolean;

		typescript?: typeof ts;
	}
	export interface FilterSettings {
		referencedFrom: string[];
	}
	export import Project = project.Project;
	export import reporter = _reporter;
	export function createProject(settings: Settings): Project {
		return new Project(getCompilerOptions(settings), settings.noExternalResolve ? true : false, settings.sortOutput ? true : false, settings.typescript);
	}

	export function filter(project: Project, filters: FilterSettings): NodeJS.ReadWriteStream {
		var filterObj: _filter.Filter = undefined;
		return through2.obj(function (file: gutil.File, encoding, callback: () => void) {
			if (!filterObj) { // Make sure we create the filter object when the compilation is complete.
				filterObj = new _filter.Filter(project, filters);
			}

			if (filterObj.match(file.path)) this.push(file);

			callback();
		});
	}
}

export = compile;
