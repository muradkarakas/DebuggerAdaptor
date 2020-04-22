/*---------------------------------------------------------
 * Sodium Debugger Adaptor Protocol Implementation
 * by Murad Karakaş
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import { ChildProcess } from 'child_process';
import { InputBoxOptions } from 'vscode';
import { DebugProtocol } from 'vscode-debugprotocol';

const { spawn } = require('child_process');

import { SodiumUtils } from './SodiumUtils';
import { SodiumDebugSession } from './SodiumDebug';
import { Variable } from 'vscode-debugadapter/lib/debugSession';

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
export class MockRuntime extends EventEmitter
{
	public static _sdPath: string | undefined = undefined;
	public static _trace: boolean | undefined = undefined;
	public static _SodiumSessionId: number | undefined = undefined;
	public SodiumDebuggerProcess: ChildProcess | null = null;

	public BreakPointHitInfo: SodiumBreakPointInfo = new SodiumBreakPointInfo();

	// maps from sourceFile to array of Mock breakpoints
	private _breakPoints = new Map<string, MockBreakpoint[]>();

	// This is a temporary id. It will be replaced with real value after we get response from SodiumServer.
	private _breakpointId = 1;

	public gLocalVarResponse: DebugProtocol.VariablesResponse;
	public gArgsVarResponse: DebugProtocol.VariablesResponse;
	public gGlobalsVarResponse: DebugProtocol.VariablesResponse;
	public gStackTraceResponse: DebugProtocol.StackTraceResponse;
	public gStackTraceArguments: DebugProtocol.StackTraceArguments;
	public gEvaulateResponse: DebugProtocol.EvaluateResponse;

	// Reference to debug session
	private gMockDebugSession: SodiumDebugSession;

	constructor(mockDebugSession: SodiumDebugSession)
	{
		super();
		this.gMockDebugSession = mockDebugSession;
		this.startSodiumDebuggerProcess();
	}

	public evaulate(debugsession: SodiumDebugSession, response: DebugProtocol.EvaluateResponse, expression: string)
	{
		if (this.SodiumDebuggerProcess) {
			this.gEvaulateResponse = response;
			let cmd = "whatis " + expression + ";\r\n";
			let p = SodiumUtils.WaitForStdout();
			let that = this;
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stackRequest(debugsession: SodiumDebugSession, response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments)
	{
		if (this.SodiumDebuggerProcess) {
			this.gStackTraceResponse = response;
			this.gStackTraceArguments = args;
			let cmd = "info frame;\r\n";
			let p = SodiumUtils.WaitForStdout();
			let that = this;
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
	}

	public variablesRequest(debugsession: SodiumDebugSession, response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments)
	{
		if (this.SodiumDebuggerProcess) {
			let cmd;
			if (args.variablesReference == 1000) {
				this.gLocalVarResponse = response;
				cmd = "info locals;\r\n";
			} else if (args.variablesReference == 1001) {
				this.gArgsVarResponse = response;
				cmd = "info args;\r\n";
			} else if (args.variablesReference == 1002) {
				this.gGlobalsVarResponse = response;
				cmd = "info globals;\r\n";
			}
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
	}

	public ParseDebuggerOutput(reply: string)
	{
		let noSessionFoundReplyMatched: number = reply.indexOf("No session found");
		if (noSessionFoundReplyMatched == 0) {
			SodiumUtils.ShowMessage("Session not found: " + MockRuntime._SodiumSessionId);
			return;
		}

		let treadIdReplyMatched: any = reply.replace("\r\n", "").match(/\[New Thread (?<BreakpointId>\d+)\]/);
		if (treadIdReplyMatched) {
			SodiumUtils.ShowMessage("Attached to " + MockRuntime._SodiumSessionId);
			return;
		}

		let frameSetReplyMatched: any = reply.match(/\{ *"frameset" *: *"(?<Frame>\d+)" *\}/);
		if (frameSetReplyMatched) {
			let json = JSON.parse(reply.split("$").join("\\\\").replace("\r\n", ""));
			if (json) {
				// nothing to do
				return;
			}
		}

		let watchReplyMatched: any = reply.match(/\{ *"watch" *: *(?<Variable>\{[a-zA-Z0-9\"., \:\{\}\}]*) *\}/);
		if (watchReplyMatched) {
			let evaulateVariable = JSON.parse(watchReplyMatched.groups.Variable);
			if (evaulateVariable) {
				this.gEvaulateResponse.body = {
					result: evaulateVariable.value,
					variablesReference: 0,
					namedVariables: 1
				}
				this.gMockDebugSession.sendResponse(this.gEvaulateResponse);
				return;
			}
		}

		// 	json array match
		let jsonArrayCandidate: any = reply.replace("\r\n", "").split("$").join("\\").match(/\[[a-zA-Z0-9\"., \:\{\}\]]*/);
		if (jsonArrayCandidate) {
			let json = JSON.parse(reply.split("$").join("\\\\").replace("\r\n", ""));
			if (json) {
				if (json.frames) {
					const startFrame = (this.gStackTraceArguments.startFrame) ? this.gStackTraceArguments.startFrame: 0;
					const maxLevels = (this.gStackTraceArguments.levels) ? this.gStackTraceArguments.levels: 1000;
					const endFrame = startFrame + maxLevels;
					var vars = json;
					if (vars.frames.length > 0) {
						if (vars.frames[0].procedure) {
							const frames = new Array<any>();
							for (let i = startFrame; i < Math.min(endFrame, vars.frames.length); i++) {
								frames.push({
									id: parseFloat(vars.frames[i].stackid),
									index: i,
									name: vars.frames[i].procedure + '()',
									file: SodiumUtils.SanitizePathForSodiumDebugger(vars.frames[i].file),
									line: parseFloat(vars.frames[i].line),
									source: this.gMockDebugSession.createSource(vars.frames[i].file),
									column: 1
								});
							}
							this.gStackTraceResponse.body = {
								stackFrames: frames,
								totalFrames: frames.length
							}
							this.gMockDebugSession.sendResponse(this.gStackTraceResponse);
						}
					}
				}
				else if (json.locals)
				{
					const variables: Variable[] = [];
					for(let i = 0; i < json.locals.length; i++) {
						let v = new Variable(json.locals[i].name, json.locals[i].value);
						// @ts-ignore
						v.type = json.locals[i].type;
						variables.push(v);
					}
					this.gLocalVarResponse.body = {
						variables: variables
					};
					this.gMockDebugSession.sendResponse(this.gLocalVarResponse);
				}
				else if (json.args)
				{
					const variables: Variable[] = [];
					for(let i = 0; i < json.args.length; i++) {
						let v = new Variable(json.args[i].name, json.args[i].value);
						// @ts-ignore
						v.type = json.args[i].type;
						variables.push(v);
					}
					this.gArgsVarResponse.body = {
						variables: variables
					};
					this.gMockDebugSession.sendResponse(this.gArgsVarResponse);
				}
				else if (json.globals) {
					const variables: Variable[] = [];
					for(let i = 0; i < json.globals.length; i++) {
						let v = new Variable(json.globals[i].name, json.globals[i].value);
						// @ts-ignore
						v.type = json.globals[i].type;
						variables.push(v);
					}
					this.gGlobalsVarResponse.body = {
						variables: variables
					};
					this.gMockDebugSession.sendResponse(this.gGlobalsVarResponse);
				}
				return;
			}
		}

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
					this.sendEvent('stopOnBreakpoint');
					return;
				}
			}
		}
	}

	/**
	 * 	Set frame number.
	 */
	public frame(frameId: number)
	{
		if (this.SodiumDebuggerProcess) {
			let cmd = "frame " + frameId + ";\r\n";
			let that = this;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
	}

	/**
	 * 	 next
	 */
	public next(event: string)
	{
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let cmd = "next;\r\n";
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
			this.sendEvent(event);
		} else {
			this.sendEvent('end');
		}

	}

	/**
	 * 	 step-out
	 */
	public stepOut() {
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let cmd = "finish;\r\n";
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
		this.sendEvent('stopOnStep');
	}

	/**
	 * 	 step-in
	 */
	public stepIn()
	{
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let cmd = "step;\r\n"
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
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
			let cmd = `clearallbreakpoints \"${path}\";\r\n`;
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
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
			/*let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				// Not implemented yet
				// MockRuntime.SendCommandToSodiumDebugger(that, "break \"" + path + ":" + line + "\";\r\n");
			});*/
		} else {
			this.sendEvent('end');
		}
		//this._breakAddresses.clear();
	}

	public isSodiumSessionIdSet(): number | undefined {
		return MockRuntime._SodiumSessionId;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number) : MockBreakpoint
	{
		if (this.SodiumDebuggerProcess) {
			let that = this;
			let cmd = "break \"" + path + ":" + line + "\";\r\n";
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
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
			let cmd = "attach " + MockRuntime._SodiumSessionId + ";\r\n";
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
	}

	public isSodiumDebuggerProcessAvailable(): ChildProcess | null {
		return this.SodiumDebuggerProcess;
	}

	public async GetSodiumSessionId() {
		if (MockRuntime._SodiumSessionId === undefined) {
			let options: InputBoxOptions = {
				prompt: "Sodium Session Id: ",
				placeHolder: "ex: 75254",
				value: ""
			}
			MockRuntime._SodiumSessionId = await SodiumUtils.GetInput(options);
		}
	}

	public startSodiumDebuggerProcess() {
		const defaults = {
			cwd: '',
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		  };

		  SodiumUtils.ReleaseStdout(null);

		this.SodiumDebuggerProcess = spawn(MockRuntime._sdPath, [], defaults);
		if (this.SodiumDebuggerProcess) {
			SodiumUtils.ShowMessage("SodiumDebugger process launched");
			this.SodiumDebuggerProcess.stdin.setDefaultEncoding("ASCII");

			this.SodiumDebuggerProcess.stdout.on('data', (data) => {
				let reply = data.toString();
				try {
					this.ParseDebuggerOutput(reply);
					SodiumUtils.ReleaseStdout(reply);
				}
				catch(e) {
					console.error(`Couldn't parsed. Reply: ${reply}. Error: ${e}`);
					this.sendEvent('end');
				}
			});
			this.SodiumDebuggerProcess.stderr.on('data', (data) => {
				let reply = data.toString();
				SodiumUtils.ShowMessage(`Error: ${reply}`);
				console.error(`stderr: ${reply}`);
				this.killSodiumDebuggerProcess();
			});
			this.SodiumDebuggerProcess.on('close', (code) => {
				SodiumUtils.ShowMessage(`Communication between IDE and Sodium Debugger lost with code ${code}`);
				this.sendEvent('end');
				this.SodiumDebuggerProcess = null;
			});
			this.SodiumDebuggerProcess.on('exit', (code) => {
				switch(code) {
					case 10: {
						SodiumUtils.ShowMessage(`Sodium Server is not running or not accessible !`);
						break;
					}
					default: {
						SodiumUtils.ShowMessage(`Sodium Server is not running or not accessible ! Code: ${code}`);
						break;
					}
				}
				this.sendEvent('end');
				this.SodiumDebuggerProcess = null;
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
			let cmd = "continue;\r\n"
			let p = SodiumUtils.WaitForStdout();
			p.then(function () {
				SodiumUtils.SendCommandToSodiumDebugger(that, cmd);
			});
		} else {
			this.sendEvent('end');
		}
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
			//this._breakAddresses.add(address);
			return true;
		}
		return false;
	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}