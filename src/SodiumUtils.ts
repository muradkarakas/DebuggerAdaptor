import { window, InputBoxOptions } from 'vscode';

import { Mutex } from 'await-semaphore';

export class SodiumUtils
{
	public static mutex = new Mutex();
	public static release: Function;

	public static async WaitForStdout(): Promise<any>
	{
		SodiumUtils.release = await SodiumUtils.mutex.acquire();

		return new Promise<any>(function(a) { a() });
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