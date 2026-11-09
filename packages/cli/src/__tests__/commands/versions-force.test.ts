import * as clack from "@clack/prompts";
import {
	mockConsoleMethods,
	runInTempDir,
	seed,
} from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw/http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMockDeployContext } from "../helpers/mock-deploy-context.js";
import { createFetchResult, msw, setupMsw } from "../helpers/msw.js";
import { runCf } from "../helpers/run-cf.js";
import "../../lib/auth.js";
import {
	ACCOUNT_ID,
	buildOutputRootConfig,
	mockDefaultHandlers,
	mockExistingWorker,
	mockWorkerUpload,
	recordRequests,
	workerConfig,
} from "./deploy/helpers.js";

vi.mock("../../lib/deploy-context.js", () => ({
	createDeployContext: (authToken: string) =>
		createMockDeployContext(authToken),
}));

describe("cf workers versions create --force", () => {
	setupMsw();
	runInTempDir();
	const std = mockConsoleMethods();
	const command = ["workers", "versions", "create", "--prebuilt"];

	beforeEach(() => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-api-token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID);
		mockDefaultHandlers();
		mockExistingWorker({ lastDeployedFrom: "api" });
	});

	async function seedWorker(overrides: Record<string, unknown> = {}) {
		await seed({
			".cloudflare/output/v0/config.json": buildOutputRootConfig(),
			".cloudflare/output/v0/workers/default/worker.config.json":
				workerConfig(overrides),
			".cloudflare/output/v0/workers/default/bundle/index.js":
				"export class TestWorkflow {}; export default {};",
		});
	}

	it.each([{ flags: [] }, { flags: ["--quiet"] }, { flags: ["--no-force"] }])(
		"stays strict in CI with $flags",
		async ({ flags }) => {
			const upload = mockWorkerUpload();
			const requests = recordRequests();
			const success = vi
				.spyOn(clack.log, "success")
				.mockImplementation(() => {});
			const previousExitCode = process.exitCode;
			try {
				await seedWorker();
				const { exitCode } = await runCf([...command, ...flags], {
					CI: "true",
				});
				expect(exitCode).toBe(1);
				expect(upload.metadata).toBeUndefined();
				expect(requests.every((request) => request.startsWith("GET "))).toBe(
					true
				);
				expect(std.err).toContain("cf workers versions create --force");
				expect(std.err).not.toContain("remove the `--strict` flag");
				expect(success).not.toHaveBeenCalledWith(
					"Version upload complete",
					expect.anything()
				);
			} finally {
				process.exitCode = previousExitCode;
				success.mockRestore();
			}
		}
	);

	it.each(["--force", "-f"])(
		"uploads an API-origin version with %s without activating it",
		async (flag) => {
			const upload = mockWorkerUpload();
			const requests = recordRequests();
			const warn = vi.spyOn(clack.log, "warn").mockImplementation(() => {});
			try {
				await seedWorker();
				const { exitCode } = await runCf([...command, flag, "--quiet"], {
					CI: "true",
				});
				expect(exitCode).toBe(0);
				expect(upload.metadata?.main_module).toBe("index.js");
				expect(
					requests.filter((request) => !request.startsWith("GET "))
				).toEqual([
					expect.stringMatching(
						/^POST .*\/workers\/scripts\/test-worker\/versions(?:\?|$)/
					),
				]);
				expect(warn).toHaveBeenCalledWith(
					"Using --force may overwrite conflicting remote Worker changes.",
					expect.objectContaining({ output: process.stderr })
				);
			} finally {
				warn.mockRestore();
			}
		}
	);

	it("does not warn or access the API during a forced dry run", async () => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);
		const requests = recordRequests();
		const warn = vi.spyOn(clack.log, "warn").mockImplementation(() => {});
		try {
			await seedWorker();
			expect(
				await runCf([...command, "--force", "--dry-run"], { CI: "true" })
			).toEqual({ exitCode: 0 });
			expect(requests).toEqual([]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it.each([401, 403])(
		"still rejects Workflow HTTP %s after accepting the origin conflict",
		async (status) => {
			const upload = mockWorkerUpload();
			const requests = recordRequests();
			msw.use(
				http.get("*/accounts/:accountId/workflows/test-workflow", () =>
					HttpResponse.json(
						createFetchResult(null, false, [
							{ code: 10000, message: "Authentication error" },
						]),
						{ status }
					)
				)
			);
			await seedWorker({
				exports: { TestWorkflow: { type: "workflow", name: "test-workflow" } },
			});
			await expect(
				runCf([...command, "--force"], { CI: "true" })
			).rejects.toMatchObject({ code: 10000 });
			expect(
				requests.some((request) => request.endsWith("/workflows/test-workflow"))
			).toBe(true);
			expect(requests.every((request) => request.startsWith("GET "))).toBe(
				true
			);
			expect(upload.metadata).toBeUndefined();
		}
	);

	it("reads a same-owner Workflow before uploading without activating", async () => {
		const upload = mockWorkerUpload();
		const requests = recordRequests();
		msw.use(
			http.get("*/accounts/:accountId/workflows/test-workflow", () =>
				HttpResponse.json(
					createFetchResult({
						name: "test-workflow",
						script_name: "test-worker",
						class_name: "TestWorkflow",
						jurisdiction: "eu",
					})
				)
			)
		);
		await seedWorker({
			exports: {
				TestWorkflow: {
					type: "workflow",
					name: "test-workflow",
					jurisdiction: "eu",
				},
			},
		});
		expect(await runCf([...command, "--force"], { CI: "true" })).toEqual({
			exitCode: 0,
		});
		expect(upload.metadata?.main_module).toBe("index.js");
		const workflowRead = requests.findIndex((request) =>
			request.endsWith("/workflows/test-workflow")
		);
		const versionWrite = requests.findIndex((request) =>
			request.startsWith("POST ")
		);
		expect(workflowRead).toBeGreaterThanOrEqual(0);
		expect(versionWrite).toBeGreaterThan(workflowRead);
		expect(requests.filter((request) => !request.startsWith("GET "))).toEqual([
			expect.stringMatching(
				/^POST .*\/workers\/scripts\/test-worker\/versions(?:\?|$)/
			),
		]);
	});

	it("still rejects immutable Workflow jurisdiction changes", async () => {
		const upload = mockWorkerUpload();
		const requests = recordRequests();
		msw.use(
			http.get("*/accounts/:accountId/workflows/test-workflow", () =>
				HttpResponse.json(
					createFetchResult({
						name: "test-workflow",
						script_name: "test-worker",
						class_name: "TestWorkflow",
					})
				)
			)
		);
		await seedWorker({
			exports: {
				TestWorkflow: {
					type: "workflow",
					name: "test-workflow",
					jurisdiction: "eu",
				},
			},
		});
		await expect(
			runCf([...command, "--force"], { CI: "true" })
		).rejects.toThrow("different jurisdiction");
		expect(upload.metadata).toBeUndefined();
		expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
	});
});
