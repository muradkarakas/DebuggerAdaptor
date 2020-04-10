/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	//ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, Scope, Source, Handles, Breakpoint, ContinuedEvent
} from 'vscode-debugadapter';

import { readFileSync } from 'fs';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename, dirname } from 'path';
import { MockRuntime, MockBreakpoint } from './mockRuntime';
import { Variable } from 'vscode-debugadapter';

const { Subject } = require('await-notify');

import { SodiumUtils } from './SodiumUtils';


/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface AttachRequestArguments extends DebugProtocol.AttachRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
}

export class SodiumSource extends Source {
	public dir: string;
}

export class MockDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	// Real debugger executable, SodiumDebugger.exe
	private _runtime: MockRuntime;

	private _variableHandles = new Handles<string>(1000);

	private _configurationDone = new Subject();

	private _sources = new Map<string, SodiumSource>();

	private _sourceId = 1;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._runtime = new MockRuntime();

		// setup event handlers
		this._runtime.on("Continuing.", () => {
			this.sendEvent(new ContinuedEvent(MockDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', MockDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', MockDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', MockDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', MockDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: MockBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);

			if (text === 'start' || text === 'startCollapsed' || text === 'end') {
				e.body.group = text;
				e.body.output = `group-${text}\n`;
			}

			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		this._runtime.killSodiumDebuggerProcess();
		super.disconnectRequest(response, args, request);
	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request): void {
		this._runtime.killSodiumDebuggerProcess();
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments, request?: DebugProtocol.Request): void {
		this._runtime.killSodiumDebuggerProcess();

	}


	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): Promise<void> {
		let that = this;
		await this._runtime.GetSodiumSessionId();

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = false;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = false;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = true;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = false;

		that.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		that.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): Promise<void> {
		super.configurationDoneRequest(response, args);

		if (this._runtime.isSodiumDebuggerProcessAvailable()) {
			let sessionId = this._runtime.isSodiumSessionIdSet();
			if (sessionId) {
				await sessionId;
				// notify the launchRequest that configuration has finished
				this._configurationDone.notify();
			}
		}
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments, request?: DebugProtocol.Request): Promise<void> {
		if (!this._runtime.isSodiumDebuggerProcessAvailable()) {
			this.sendEvent(new TerminatedEvent());
			return;
		}

		this._runtime.sendAttachRequestToSodiumServer();

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		this._runtime.start(args.program, !!args.stopOnEntry);

		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, this.convertClientLineToDebugger(args.line));
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					}
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void
	{
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(MockDebugSession.THREAD_ID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void
	{
		this._runtime.frame(args.frameId);

		response.body = {
			scopes: [
				new Scope("Local", 1000, false),
				new Scope("Parameters", 1001, false),
				new Scope("Global", 1002, false)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request)
	{
		const variables: Variable[] = [];
		(async () => {
			await this._runtime.variablesRequest();
			var vars = MockRuntime.gJsonObject;
			if (vars) {
				if (args.variablesReference == 1000) {
					if (vars.locals) {
						for(let i = 0; i < vars.locals.length; i++) {
							let v = new Variable(vars.locals[i].name, vars.locals[i].value);
							// @ts-ignore
							v.type = vars.locals[i].type;
							variables.push(v);
						}
					}
				}
			}
			response.body = {
				variables: variables
			};
			this.sendResponse(response);
		})();
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void
	{
		(async () => {
			const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
			const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
			const endFrame = startFrame + maxLevels;

			await this._runtime.stackRequest(startFrame, endFrame);

			var vars = MockRuntime.gJsonObject;
			if (vars && vars.frames) {
				if (vars.frames.length > 0) {
					if (vars.frames[0].procedure) {
						const frames = new Array<any>();
						for (let i = startFrame; i < Math.min(endFrame, vars.frames.length); i++) {
							frames.push({
								id: parseFloat(vars.frames[i].stackid),
								index: i,
								name: vars.frames[i].procedure + '()',
								file: vars.frames[i].file.replace("C:", "c:"),
								line: parseFloat(vars.frames[i].line),
								source: this.createSource(vars.frames[i].file),
								column: 1
							});
						}
						response.body = {
							stackFrames: frames,
							totalFrames: frames.length
						}
					}
				}
				this.sendResponse(response);
			}
		})();
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this._runtime.continue(true);
		this.sendResponse(response);
 	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void
	{
		this._runtime.next('stopOnStep');
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request): void
	{
		this._runtime.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): void
	{
		this._runtime.stepOut();
		this.sendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void
	{
		response.body = {
            dataId: null,
            description: "cannot break on data access",
            accessTypes: undefined,
            canPersist: false
        };

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = [ "read" ];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (let dbp of args.breakpoints) {
			// assume that id is the "address" to break on
			const ok = this._runtime.setDataBreakpoint(dbp.dataId);
			response.body.breakpoints.push({
				verified: ok
			});
		}

		this.sendResponse(response);
	}

	//---- helpers

	private createSource(filePath: string): SodiumSource
	{
		let source: SodiumSource | undefined = this._sources.get(filePath);
		if (source)
			return source;

		source = this.findSourceByName(filePath);
		if (source)
			return source;

		source = new SodiumSource(basename(filePath), filePath, this._sourceId, undefined, 'mock-adapter-data');
		source.dir = dirname(filePath);
		this._sources.set(filePath, source);
		this._sourceId++;
		return source;
	}

	protected findSourceByName(name: string): SodiumSource | undefined
	{
		let retval: SodiumSource | undefined = undefined;
		for(var [, value] of this._sources) {
			if (value.name == name) {
				retval = value;
				break;
			}
		}
		return retval;
	}

	protected findSourceByRefId(refId: number): SodiumSource | undefined
	{
		let retval: SodiumSource | undefined = undefined;
		for(var [, value] of this._sources) {
			if (value.sourceReference == refId) {
				retval = value;
				break;
			}
		}
		return retval;
	}

	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void
	{
		let sourceLines: string = '';
        try {
			if (args.source) {
				if (args.source.path) {
					let fPath: string | undefined = undefined;
					let ss: SodiumSource = (args.source as SodiumSource);
					if (ss.dir)
						fPath = ss.dir + "\\" + ss.name;
					else
						fPath = args.source.path;

					sourceLines = readFileSync(fPath).toString();//.split('\n');
				}
			}

            response.body = {
				content: sourceLines,
				//mimeType: 'javascript'
			}
		}
		catch (error) {
            this.sendErrorResponse(response, error)
            return
        }
        this.sendResponse(response)
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void
	{
		const clientLines = args.lines || [];
		let actualBreakpoints: Array<any> = new Array<any>();

		if (args.source.path) {
			const path = args.source.path;
			this._runtime.clearBreakpoints(args.source.path);
			for(let i = 0; i < clientLines.length; i++) {
				let { verified, line, id } = this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(clientLines[i]));
				const bp = <DebugProtocol.Breakpoint> new Breakpoint(verified, this.convertDebuggerLineToClient(line));
				bp.id= id;
				bp.source = this.createSource(args.source.path);
				actualBreakpoints.push(bp);
			}
		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: actualBreakpoints
		};

		SodiumUtils.release();

		this.sendResponse(response);
	}
}
