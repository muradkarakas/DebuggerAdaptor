import { window, InputBoxOptions } from 'vscode';

import { Mutex } from 'await-semaphore';
import { MockRuntime } from './mockRuntime';

export class SodiumUtils
{
	public static mutex = new Mutex();
	private static _stdoutResolver: Function | undefined;

	public static ReleaseStdout(reply: string)
	{
		if (SodiumUtils._stdoutResolver)
			SodiumUtils._stdoutResolver();
		SodiumUtils._stdoutResolver = undefined;
	}

	public static async WaitForStdout(): Promise<any>
	{
		SodiumUtils._stdoutResolver = await SodiumUtils.mutex.acquire();

		return new Promise<any>(function(a) { a() });
	}

	public static SendCommandToSodiumDebugger(runtime: MockRuntime, command: string): void
	{
		if (runtime && runtime.SodiumDebuggerProcess != null) {
			runtime.SodiumDebuggerProcess.stdin.cork();
			runtime.SodiumDebuggerProcess.stdin.write(command);
			runtime.SodiumDebuggerProcess.stdin.uncork();
		}
	}

	public static SanitizePathForSodiumDebugger(path: string): string
	{
		return path.replace("C:", "c:").replace("D:", "d:").replace("E:", "d:");
	}

	public static async GetInput(options: InputBoxOptions): Promise<any> {
		let retval: any = undefined;

		let input = window.showInputBox(options);
		await input.then(value => {
			if (value)
				retval = value;
		});
		return Promise.resolve(retval);
	}

}