///<reference path='../definitions/ref.d.ts'/>

import ts = require('typescript');
import tsApi = require('./tsapi');
import main = require('./main');
import gutil = require('gulp-util');
import sourceMap = require('source-map');
import path = require('path');
import stream = require('stream');
import fs = require('fs'); // Only used for readonly access
import host = require('./host');
import filter = require('./filter');
import reporter = require('./reporter');

export interface Map<T> {
	[key: string]: T;
}
export interface FileData {
	file?: gutil.File;
	filename: string;
	originalFilename: string;
	content: string;
	ts: ts.SourceFile;
}
interface OutputFile {
	filename: string;
	content: string;
	sourcemap?: Object;
}



export class Project {
	static unresolvedFile: FileData = {
		filename: undefined,
		originalFilename: undefined,
		content: undefined,
		ts: undefined
	};

	/**
	 * The TypeScript library that is used for this project.
	 * Can also be jsx-typescript for example.
	 */
	typescript: typeof ts;

	filterSettings: main.FilterSettings;

	/**
	 * Files from the previous compilation.
	 * Used to find the differences with the previous compilation, to make the new compilation faster.
	 */
	previousFiles: Map<FileData> = {};
	/**
	 * The files in the current compilation.
	 * This Map only contains the files in the project, not external files. Those are in Project#additionalFiles.
	 * The file property of the FileData objects in this Map are set.
	 */
	currentFiles: Map<FileData> = {};
	/**
	 * External files of the current compilation.
	 * When a file is imported by or referenced from another file, and the file is not one of the input files, it
	 * is added to this Map. The file property of the FileData objects in this Map are not set.
	 */
	additionalFiles: Map<FileData> = {};
	/**
	 *
	 */
	firstFile: FileData = undefined;

	private isFileChanged: boolean = false;
	private previousOutputJS: OutputFile[];
	private previousOutputDts: OutputFile[];

	/**
	 * Whether there should not be loaded external files to the project.
	 * Example:
	 *   In the lib directory you have .ts files.
	 *   In the definitions directory you have the .d.ts files.
	 *   If you turn this option on, you should add in your gulp file the definitions directory as an input source.
	 * Advantage:
	 * - Faster builds
	 * Disadvantage:
	 * - If you forget some directory, your compile will fail.
	 */
	private noExternalResolve: boolean;
	/**
	 * Sort output based on <reference> tags.
	 * tsc does this when you pass the --out parameter.
	 */
	private sortOutput: boolean;

	/**
	 * The version number of the compilation.
	 * This number is increased for every compilation in the same gulp session.
	 * Used for incremental builds.
	 */
	version: number = 0;

	options: ts.CompilerOptions;
	host: host.Host;
	program: ts.Program;

	constructor(options: ts.CompilerOptions, noExternalResolve: boolean, sortOutput: boolean, typescript = ts) {
		this.typescript = typescript;
		this.options = options;

		this.noExternalResolve = noExternalResolve;
		this.sortOutput = sortOutput;
	}

	/**
	 * Resets the compiler.
	 * The compiler needs to be reset for incremental builds.
	 */
	reset() {
		this.previousFiles = this.currentFiles;
		this.firstFile = undefined;

		this.isFileChanged = false;

		this.currentFiles = {};
		this.additionalFiles = {};

		this.version++;
	}
	/**
	 * Adds a file to the project.
	 */
	addFile(file: gutil.File) {
		var fileData: FileData;
		var filename = Project.normalizePath(file.path);

		// Incremental compilation
		var oldFileData = this.previousFiles[filename];
		if (oldFileData) {
			if (oldFileData.content === file.contents.toString('utf8')) {
				// Unchanged, we can use the (ts) file from previous build.
				fileData = {
					file: file,
					filename: oldFileData.filename,
					originalFilename: file.path,
					content: oldFileData.content,
					ts: oldFileData.ts
				};
			} else {
				fileData = this.getFileDataFromGulpFile(file);
				this.isFileChanged = true;
			}
		} else {
			fileData = this.getFileDataFromGulpFile(file);
			this.isFileChanged = true;
		}

		if (!this.firstFile) this.firstFile = fileData;
		this.currentFiles[Project.normalizePath(file.path)] = fileData;
	}

	getOriginalName(filename: string): string {
		return filename.replace(/(\.d\.ts|\.js|\.js.map)$/, '.ts')
	}
	private getError(info: ts.Diagnostic): reporter.TypeScriptError {
		var err = <reporter.TypeScriptError> new Error();
		err.name = 'TypeScript error';
		err.diagnostic = info;

		if (!info.file) {
			err.message = info.code + ' ' + tsApi.flattenDiagnosticMessageText(this.typescript, info.messageText);

			return err;
		}

		var filename = this.getOriginalName(tsApi.getFileName(info.file));
		var file = this.host.getFileData(filename);

		if (file) {
			err.tsFile = file.ts;
			err.fullFilename = file.originalFilename;
			if (file.file) {
				filename = path.relative(file.file.cwd, file.originalFilename);
				err.relativeFilename = filename;
				err.file = file.file;
			} else {
				filename = file.originalFilename;
			}
		} else {
			filename = tsApi.getFileName(info.file);
			err.fullFilename = filename;
		}

		var startPos = tsApi.getLineAndCharacterOfPosition(this.typescript, info.file, info.start);
		var endPos = tsApi.getLineAndCharacterOfPosition(this.typescript, info.file, info.start + info.length);

		err.startPosition = {
			position: info.start,
			line: startPos.line,
			character: startPos.character
		};
		err.endPosition = {
			position: info.start + info.length - 1,
			line: endPos.line,
			character: endPos.character
		};

		err.message = gutil.colors.red(filename + '(' + startPos.line + ',' + startPos.character + '): ')
			+ info.code + ' '
			+ tsApi.flattenDiagnosticMessageText(this.typescript, info.messageText);

		return err;
	}

	lazyCompile(jsStream: stream.Readable, declStream: stream.Readable): boolean {
		if (this.isFileChanged === false
			&& Object.keys(this.currentFiles).length === Object.keys(this.previousFiles).length
			&& this.previousOutputJS !== undefined
			&& this.previousOutputDts !== undefined) {
			// Emit files from previous build, since they are the same.

			// JavaScript files
			for (var i = 0; i < this.previousOutputJS.length; i++) {
				var file = this.previousOutputJS[i];

				var originalName = this.getOriginalName(Project.normalizePath(file.filename));
				var original: FileData = this.currentFiles[originalName];

				if (!original) continue;

				var gFile = new gutil.File({
					path: original.originalFilename.substr(0, original.originalFilename.length - 3) + '.js',
					contents: new Buffer(file.content),
					cwd: original.file.cwd,
					base: original.file.base
				});

				gFile.sourceMap = file.sourcemap;

				jsStream.push(gFile);
			}

			// Definitions files
			for (var i = 0; i < this.previousOutputDts.length; i++) {
				var file = this.previousOutputDts[i];

				var originalName = this.getOriginalName(Project.normalizePath(file.filename));
				var original: FileData = this.currentFiles[originalName];

				if (!original) continue;

				declStream.push(new gutil.File({
					path: original.originalFilename.substr(0, original.originalFilename.length - 3) + '.d.ts',
					contents: new Buffer(file.content),
					cwd: original.file.cwd,
					base: original.file.base
				}));
			}

			return true;
		}

		return false;
	}

	private resolve(session: { tasks: number; callback: () => void; }, file: FileData) {
		var references = file.ts.referencedFiles.map(item => path.join(path.dirname(tsApi.getFileName(file.ts)), tsApi.getFileName(item)));

		for (var i = 0; i < references.length; ++i) {
			((i: number) => { // create scope
				var ref = references[i];
				var normalizedRef = Project.normalizePath(ref);

				if (!this.currentFiles.hasOwnProperty(normalizedRef) && !this.additionalFiles.hasOwnProperty(normalizedRef)) {
					session.tasks++;

					this.additionalFiles[normalizedRef] = Project.unresolvedFile;

					fs.readFile(ref, (error, data) => {
						if (data) { // Typescript will throw an error when a file isn't found.
							var file = this.getFileData(ref, data.toString('utf8'));
							this.additionalFiles[normalizedRef] = file;
							this.resolve(session, file);
						}

						session.tasks--;
						if (session.tasks === 0) session.callback();
					});
				}
			})(i);
		}
	}
	resolveAll(callback: () => void) {
		if (this.noExternalResolve) {
			callback();
			return;
		}

		var session = {
			tasks: 0,
			callback: callback
		};

		for (var i in this.currentFiles) {
			if (this.currentFiles.hasOwnProperty(i)) {
				this.resolve(session, this.currentFiles[i]);
			}
		}

		if (session.tasks === 0) {
			callback();
		}
	}

	/**
	 * Compiles the input files
	 */
	compile(jsStream: stream.Readable, declStream: stream.Readable, errorCallback: (err: reporter.TypeScriptError) => void) {
		var files: Map<FileData> = {};

		var _filter: filter.Filter;
		if (this.filterSettings !== undefined) {
			_filter = new filter.Filter(this, this.filterSettings);
		}

		var rootFilenames: string[] = [];

		for (var filename in this.currentFiles) {
			if (this.currentFiles.hasOwnProperty(filename)) {
				if (!_filter || _filter.match(filename)) {
					files[filename] = this.currentFiles[filename];
					rootFilenames.push(files[filename].originalFilename);
				}
			}
		}
		for (var filename in this.additionalFiles) {
			if (this.additionalFiles.hasOwnProperty(filename)) {
				files[filename] = this.additionalFiles[filename];
			}
		}

		this.host = new host.Host(this.typescript, this.currentFiles[0] ? this.currentFiles[0].file.cwd : '', files, !this.noExternalResolve);

		// Creating a program compiles the sources
		this.program = this.typescript.createProgram(rootFilenames, this.options, this.host);

		var errors = tsApi.getDiagnosticsAndEmit(this.program);

		for (var i = 0; i < errors.length; i++) {
			errorCallback(this.getError(errors[i]));
		}

		var outputJS: gutil.File[] = [];
		var sourcemaps: { [ filename: string ]: string } = {};

		if (errors.length) {
			this.previousOutputJS = undefined;
			this.previousOutputDts = undefined;
		} else {
			this.previousOutputJS = [];
			this.previousOutputDts = [];
		}

		for (var filename in this.host.output) {
			if (!this.host.output.hasOwnProperty(filename)) continue;

			var originalName = this.getOriginalName(Project.normalizePath(filename));
			var original: FileData;
			if (this.options.out !== undefined) {
				original = this.firstFile;
				if (!original) continue;

				var fullOriginalName = path.join(original.file.base, this.options.out);
			} else {
				original = this.currentFiles[originalName];
				if (!original) continue;

				var fullOriginalName = original.originalFilename;
			}

			var lastDot = fullOriginalName.lastIndexOf('.');
			if (lastDot === -1) lastDot = fullOriginalName.length;
			var fullOriginalNameWithoutExtension = fullOriginalName.substring(0, lastDot);

			var data: string = this.host.output[filename];


			if (filename.substr(-3) === '.js') {
				var file = new gutil.File({
					path: fullOriginalNameWithoutExtension + '.js',
					contents: new Buffer(this.removeSourceMapComment(data)),
					cwd: original.file.cwd,
					base: original.file.base
				});

				outputJS.push(file);
			} else if (filename.substr(-5) === '.d.ts') {
				var file = new gutil.File({
					path: fullOriginalNameWithoutExtension + '.d.ts',
					contents: new Buffer(data),
					cwd: original.file.cwd,
					base: original.file.base
				});

				if (this.previousOutputDts !== undefined) {
					this.previousOutputDts.push({
						filename: file.path,
						content: data
					});
				}

				declStream.push(file);
			} else if (filename.substr(-4) === '.map') {
				if (this.options.out !== undefined) {
					sourcemaps[''] = data;
				} else {
					sourcemaps[originalName] = data;
				}
			}
		}

		var emit = (originalName: string, file: gutil.File) => {
			var map = sourcemaps[this.options.out !== undefined ? '' : originalName];

			if (map) {
				var parsedMap = JSON.parse(map);
				parsedMap.file = parsedMap.file.replace(/\\/g, '/');
				parsedMap.sources = parsedMap.sources.map(function(filePath) {
					return path.relative(parsedMap.sourceRoot, originalName);
				});

				var oldFiles: string[];
				if (this.options.out !== undefined) {
					oldFiles = Object.keys(this.currentFiles);
				} else {
					oldFiles = [originalName];
				}
				var generator = sourceMap.SourceMapGenerator.fromSourceMap(new sourceMap.SourceMapConsumer(parsedMap));
				for (var i = 0; i < oldFiles.length; i++) {
					var oldFile = this.currentFiles[oldFiles[i]];
					if (!oldFile || !oldFile.file || !oldFile.file.sourceMap) continue;
					generator.applySourceMap(new sourceMap.SourceMapConsumer(oldFile.file.sourceMap));
				}
				file.sourceMap = JSON.parse(generator.toString());
			} else console.log(originalName, sourcemaps);

			if (this.previousOutputJS !== undefined) {
				this.previousOutputJS.push({
					filename: file.path,
					content: file.contents.toString(),
					sourcemap: file.sourceMap
				});
			}

			jsStream.push(file);
		};

		if (this.sortOutput) {
			var done: { [ filename: string] : boolean } = {};

			var sortedEmit = (originalName: string, file: gutil.File) => {
				originalName = Project.normalizePath(originalName);

				if (done[originalName]) return;
				done[originalName] = true;

				var inputFile = this.currentFiles[originalName];
				var tsFile = this.program.getSourceFile(originalName);
				var references = tsFile.referencedFiles.map(file => tsApi.getFileName(file));

				for (var j = 0; j < outputJS.length; ++j) {
					var other = outputJS[j];
					var otherName = this.getOriginalName(other.path);

					if (references.indexOf(otherName) !== -1) {
						sortedEmit(otherName, other);
					}
				}

				emit(originalName, file);
			};

			for (var i = 0; i < outputJS.length; ++i) {
				var file = outputJS[i];
				var originalName = this.getOriginalName(file.path);
				sortedEmit(originalName, file);
			}
		} else {
			for (var i = 0; i < outputJS.length; ++i) {
				var file = outputJS[i];
				var originalName = this.getOriginalName(file.path);
				originalName = Project.normalizePath(originalName);
				emit(originalName, file);
			}
		}
	}

	private getFileDataFromGulpFile(file: gutil.File): FileData {
		var str = file.contents.toString('utf8');

		var data = this.getFileData(file.path, str);
		data.file = file;

		return data;
	}

	private getFileData(filename: string, content: string): FileData {
		return {
			filename: Project.normalizePath(filename),
			originalFilename: filename,
			content: content,
			ts: tsApi.createSourceFile(this.typescript, filename, content, this.options.target, this.version + '')
		};
	}

	private removeSourceMapComment(content: string): string {
		// By default the TypeScript automaticly inserts a source map comment.
		// This should be removed because gulp-sourcemaps takes care of that.
		// The comment is always on the last line, so it's easy to remove it
		// (But the last line also ends with a \n, so we need to look for the \n before the other)
		var index = content.lastIndexOf('\n', content.length - 2);
		return content.substring(0, index) + '\n';
	}

	static normalizePath(pathString: string) {
		return path.normalize(pathString).toLowerCase();
	}
}
