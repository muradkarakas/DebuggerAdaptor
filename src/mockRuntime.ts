/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

//import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';
import { InputBoxOptions } from 'vscode';
import { basename } from 'path';

const { spawn } = require('child_process');

import { SodiumUtils } from './SodiumUtils';

export interface MockBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

export class SodiumBreakPointInfo {
	id: number;
	line: number;
	file: string;
	procedure: string;
}

/**
 * A Mock runtime with minimal debugger functionality.
 */
export class MockRuntime extends EventEmitter {

	private _SodiumSessionId: string | undefined = undefined;
	private SodiumDebuggerProcess: ChildProcess | null = null;

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}
	public set sourceFile(value: string) {
		this._sourceFile = value;
	}

	public BreakPointHitInfo: SodiumBreakPointInfo = new SodiumBreakPointInfo();

	// the contents (= lines) of the one and only file
	//rivate _sourceLines: string[];

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, MockBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	constructor() {
		super();
		this.startSodiumDebuggerProcess();
	}

	/**
	 * 	 next
	 */
	public next(event: string) {
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("next;\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}
		this.sendEvent(event);
	}

	/**
	 * 	 step-out
	 */
	public stepOut() {
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("finish;\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}
		this.sendEvent('stopOnStep');
	}

	/**
	 * 	 step-in
	 */
	public stepIn() {
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("step;\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}
		this.sendEvent('stopOnStep');
	}

	public SetBreakPointId(id: number, file: string, line: number)
	{
		let bp = this._breakPoints.get(file);
		if (bp) {
			for(let i=0; i < bp.length; i++) {
				if (bp[i].line == line) {
					bp[i].id = id;
					bp[i].verified = true;
					break;
				}
			}
		}
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void
	{
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("clearallbreakpoints;\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}

		this._breakPoints.delete(path);
	}


	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void
	{
		if (this.SodiumDebuggerProcess) {
			//let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				/*if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("clearallbreakpoints;\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}*/
			});
		} else {
			this.sendEvent('end');
		}

		this._breakAddresses.clear();
	}

	public isSodiumSessionIdSet(): string | undefined {
		return this._SodiumSessionId;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number) : MockBreakpoint
	{
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("break \"" + path + ":" + line + "\";\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}

		const bp = <MockBreakpoint> { verified: true, line, id: this._breakpointId };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<MockBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		this._breakpointId++;
		bps.push(bp);

		//this.verifyBreakpoints(path);

		return bp;
	}

	public killSodiumDebuggerProcess() {
		if (this.SodiumDebuggerProcess) {
			this.SodiumDebuggerProcess.kill();
			this.SodiumDebuggerProcess = null;
		} else {
			this.sendEvent('end');
		}
	}

	public sendAttachRequestToSodiumServer() {
		if (this.SodiumDebuggerProcess){
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("attach " + that._SodiumSessionId + ";\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}
	}

	public isSodiumDebuggerProcessAvailable(): ChildProcess | null {
		return this.SodiumDebuggerProcess;
	}

	public async GetSodiumSessionId() {
		let options: InputBoxOptions = {
			prompt: "Sodium Session Id: ",
			placeHolder: "ex: 75254",
			value: "62613"
		}
		this._SodiumSessionId = await SodiumUtils.GetInput(options);
	}

	public ParseDebuggerOutput(reply: string)
	{
		// break command response
		/*
		 *	Breakpoint 2 at 0x0000:  file welcome.sqlx, line 6.
		 */
		/*if (reply.startsWith("Continuing.")) {
			this.sendEvent('Continuing.');
			return;
		}*/

		// break command response
		/*
		 *	Breakpoint 2 at 0x0000:  file welcome.sqlx, line 6.
		 */
		let newBreakpointReplyMatched: any = reply.match(/(?<BreakpointId>\d{1,3}) at 0x0000:  file (?<FileName>[\.:\-\w\\]+), line (?<LineNo>\d+)/);
		if (newBreakpointReplyMatched) {
			if (newBreakpointReplyMatched.groups) {
				let g = newBreakpointReplyMatched.groups;
				//this._currentLine = g.LineNo + 1;
				this.SetBreakPointId(parseFloat(g.BreakpointId), g.FileName, parseFloat(g.LineNo));
				return;
			}
		}

		// Breakpoint hit response
		/*
		 *  Breakpoint 2, cb_oracle.logon2oracle() at C:\projects\Sodium\Setup\Sodium-Site\welcome.sqlx:6
		 *  C:\projects\Sodium\Setup\Sodium-Site\welcome.sqlx:6:1:beg:0x0000
		 */
		let breakpointHitReplyMatched: any = reply.match(/(?<BreakpointId>\d{1,3}), (?<ProcedureName>[\(\)\.:\-\w\\]+) at (?<FileName>[\.:\-\w\\]+):(?<LineNo>\d{1,3})/);
		if (breakpointHitReplyMatched) {
			if (breakpointHitReplyMatched.groups) {
				let g = breakpointHitReplyMatched.groups;
				if (g.BreakpointId)
					this.BreakPointHitInfo.id = parseFloat(g.BreakpointId);
				if (g.ProcedureName)
					this.BreakPointHitInfo.procedure = g.ProcedureName;
				if (g.FileName)
					this.BreakPointHitInfo.file = g.FileName;
				if (g.LineNo)
					this.BreakPointHitInfo.line = parseFloat(g.LineNo);

				this.sendEvent('stopOnBreakpoint');
				return;
			}
		} else {
			// next response
			/*
			*  C:\projects\Sodium\Setup\Sodium-Site\welcome.sqlx:6:1:beg:0x0000
			*/
			breakpointHitReplyMatched = reply.match(/\32\32(?<Drive>.):(?<FileName>[\.\-\w\\]+):(?<LineNo>\d{1,3})/);
			if (breakpointHitReplyMatched) {
				if (breakpointHitReplyMatched.groups) {
					let g = breakpointHitReplyMatched.groups;
					if (g.FileName)
						this.BreakPointHitInfo.file = g.Drive + ":" + g.FileName;
					if (g.LineNo)
						this.BreakPointHitInfo.line = parseFloat(g.LineNo);

					//this.BreakPointHitInfo = g;
					this.sendEvent('stopOnBreakpoint');
					return;
				}
			}
		}
	}

	public startSodiumDebuggerProcess() {
		const defaults = {
			cwd: 'C:\\projects\\Sodium\\Setup\\',
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		  };

		this.SodiumDebuggerProcess = spawn('C:\\projects\\Sodium\\Setup\\SodiumDebugger.exe', [], defaults);
		if (this.SodiumDebuggerProcess) {
			this.SodiumDebuggerProcess.stdin.setDefaultEncoding("ASCII");

			this.SodiumDebuggerProcess.stdout.on('data', (data) => {
				let reply = data.toString();
				console.log(reply);
				this.ParseDebuggerOutput(reply);
				SodiumUtils.release();
			});
			this.SodiumDebuggerProcess.stderr.on('data', (data) => {
				let reply = data.toString();
				console.error(`stderr: ${reply}`);
				this.killSodiumDebuggerProcess();
			});
			this.SodiumDebuggerProcess.on('close', (code) => {
				this.sendEvent('end');
				this.SodiumDebuggerProcess = null;
				console.log(`Communication between IDE and Sodium Debugger lost with code ${code}`);
			});
			this.SodiumDebuggerProcess.on('exit', (code) => {
				this.sendEvent('end');
				this.SodiumDebuggerProcess = null;
				switch(code) {
					case 10: {
						console.log(`Sodium Server is not running or not accessible !`);
						break;
					}
				}

			});
			this.SodiumDebuggerProcess.on('message', (m) => {
				console.log('CHILD got message:', m);
			});
		} else {
			this.sendEvent('end');
		}
	}


	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean)
	{
		this.loadSource(program);
		//this._currentLine = -1;

		//this.verifyBreakpoints(this._sourceFile);

		if (stopOnEntry) {
			// we step once
			this.next('stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false)
	{
		if (this.SodiumDebuggerProcess){
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				if (that.SodiumDebuggerProcess != null) {
					that.SodiumDebuggerProcess.stdin.cork();
					that.SodiumDebuggerProcess.stdin.write("continue;\r\n");
					that.SodiumDebuggerProcess.stdin.uncork();
				}
			});
		} else {
			this.sendEvent('end');
		}
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): any
	{
		const frames = new Array<any>();

		frames.push({
			index: 1,
			name: this.BreakPointHitInfo.procedure,
			file: basename(this.BreakPointHitInfo.file),//.replace("C:", "c:"),
			line: this.BreakPointHitInfo.line,
			column: 1
		});

		return {
			frames: frames,
			count: frames.length
		};
	}

	public getBreakpoints(path: string, line: number): number[]
	{
		const bps: number[] = [];
		let bpsf = this._breakPoints.get(path);
		if (bpsf) {
			for (let i = 0; i < bpsf.length; i++) {
				bps.push(bpsf[i].line);
			}
		}
		return bps;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : MockBreakpoint | undefined
	{
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}


	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
	}

	// private methods
	private loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			//this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		}
	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}