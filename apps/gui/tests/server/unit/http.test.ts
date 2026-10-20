import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	allowedOrigins,
	checkRequestGuard,
	contentDisposition,
	corsHeaders,
	HttpError,
	hasJsonOrEmptyBody,
	isAllowedHost,
	isAllowedOrigin,
	json,
	readJson,
	refererOrigin,
	toHttpError,
} from "../../../server/http.js";

const mkReq = (method: string, headers: Record<string, string>) =>
	({ method, headers: { host: "localhost:3456", ...headers } }) as unknown as http.IncomingMessage;

describe("origin allow-list", () => {
	it.each([
		"http://localhost:1420",
		"http://127.0.0.1:1420",
		"http://tauri.localhost",
		"https://tauri.localhost",
		"tauri://localhost",
		"http://localhost:1420/",
		"HTTP://LOCALHOST:1420",
	])("allows %s", (o) => expect(isAllowedOrigin(o)).toBe(true));

	it.each([
		"https://evil.example",
		"http://localhost.evil.example",
		"http://tauri.localhost.evil.com",
		"http://localhost:8080", // any other localhost port is NOT the app
		"http://127.0.0.1:5173",
		"http://localhost",
		"file://",
		"null",
		"",
	])("rejects %s", (o) => expect(isAllowedOrigin(o)).toBe(false));

	it("never treats a missing origin as allowed", () => {
		expect(isAllowedOrigin(undefined)).toBe(false);
		expect(isAllowedOrigin(null)).toBe(false);
	});

	it("adds LR_ALLOWED_ORIGINS (comma list)", () => {
		const set = allowedOrigins({ LR_ALLOWED_ORIGINS: " http://localhost:4173/ ,http://x.test" });
		expect(isAllowedOrigin("http://localhost:4173", set)).toBe(true);
		expect(isAllowedOrigin("http://x.test", set)).toBe(true);
		expect(isAllowedOrigin("http://localhost:1420", set)).toBe(true);
		expect(isAllowedOrigin("http://localhost:4173")).toBe(false);
	});

	it("extracts the referer origin, including custom schemes", () => {
		expect(refererOrigin(mkReq("GET", { referer: "http://tauri.localhost/sessions" }))).toBe(
			"http://tauri.localhost",
		);
		expect(refererOrigin(mkReq("GET", { referer: "tauri://localhost/x" }))).toBe(
			"tauri://localhost",
		);
		expect(refererOrigin(mkReq("GET", {}))).toBeNull();
		expect(refererOrigin(mkReq("GET", { referer: "::nope" }))).toBeNull();
	});

	it("echoes only allowed origins in CORS headers", () => {
		expect(corsHeaders("http://localhost:1420")["Access-Control-Allow-Origin"]).toBe(
			"http://localhost:1420",
		);
		expect(corsHeaders("https://evil.example")["Access-Control-Allow-Origin"]).toBeUndefined();
		expect(corsHeaders("null")["Access-Control-Allow-Origin"]).toBeUndefined();
	});
});

describe("host guard (DNS rebinding)", () => {
	it.each([
		["localhost:3456", 3456],
		["localhost", 3456],
		["127.0.0.1:3456", 3456],
		["[::1]:3456", 3456],
		["tauri.localhost", 3456],
		["LOCALHOST:3456", 3456],
	])("allows %s", (host, port) => expect(isAllowedHost(host, port)).toBe(true));

	it.each([
		["evil.example:3456", 3456],
		["attacker.com", 3456],
		["localhost:9999", 3456],
		["127.0.0.2:3456", 3456],
		["localhost.evil.com:3456", 3456],
		["", 3456],
		[undefined, 3456],
	])("rejects %s", (host, port) => expect(isAllowedHost(host, port)).toBe(false));
});

describe("request guard", () => {
	const guard = (method: string, headers: Record<string, string>) =>
		checkRequestGuard(mkReq(method, headers), { port: 3456 })?.status ?? 200;

	it("rejects `Origin: null` for every method (sandboxed iframes, data: URLs)", () => {
		expect(guard("POST", { origin: "null" })).toBe(403);
		expect(guard("GET", { origin: "null" })).toBe(403);
		expect(guard("OPTIONS", { origin: "null" })).toBe(403);
	});

	it("rejects a rebinding Host even with an allowed origin", () => {
		expect(guard("GET", { host: "evil.example:3456", origin: "http://localhost:1420" })).toBe(403);
	});

	it("accepts allowed origins and rejects others", () => {
		expect(
			guard("POST", { origin: "http://tauri.localhost", "sec-fetch-site": "cross-site" }),
		).toBe(200);
		expect(guard("POST", { origin: "http://localhost:8080" })).toBe(403);
	});

	it("accepts origin-less state-changing requests only from non-browser clients", () => {
		// CLI / curl / node fetch (sends Sec-Fetch-Mode but never Sec-Fetch-Site)
		expect(guard("POST", {})).toBe(200);
		expect(guard("DELETE", { "sec-fetch-mode": "cors" })).toBe(200);
		// a browser without Origin (any Sec-Fetch-Site) is refused
		for (const site of ["cross-site", "same-site", "same-origin", "none"]) {
			expect(guard("POST", { "sec-fetch-site": site })).toBe(403);
		}
		expect(
			guard("POST", { referer: "http://localhost:1420/", "sec-fetch-site": "cross-site" }),
		).toBe(403);
	});

	it("requires an allowed Referer for cross-site GETs without Origin (<audio>, downloads)", () => {
		expect(guard("GET", { "sec-fetch-site": "cross-site" })).toBe(403);
		expect(guard("GET", { "sec-fetch-site": "same-site", referer: "https://evil.example/" })).toBe(
			403,
		);
		expect(
			guard("GET", { "sec-fetch-site": "cross-site", referer: "http://tauri.localhost/sessions" }),
		).toBe(200);
		expect(guard("GET", { "sec-fetch-site": "same-origin" })).toBe(200);
		expect(guard("GET", { "sec-fetch-site": "none" })).toBe(200);
		expect(guard("GET", {})).toBe(200);
	});
});

describe("hasJsonOrEmptyBody", () => {
	const req = (headers: Record<string, string>) => mkReq("POST", headers);
	it("accepts JSON or no body", () => {
		expect(hasJsonOrEmptyBody(req({ "content-type": "application/json" }))).toBe(true);
		expect(hasJsonOrEmptyBody(req({ "content-type": "application/json; charset=utf-8" }))).toBe(
			true,
		);
		expect(hasJsonOrEmptyBody(req({}))).toBe(true);
		expect(hasJsonOrEmptyBody(req({ "content-length": "0" }))).toBe(true);
	});
	it("rejects simple-request content types and untyped bodies", () => {
		for (const ct of [
			"text/plain",
			"text/plain;charset=UTF-8",
			"application/x-www-form-urlencoded",
			"multipart/form-data; boundary=x",
			"application/jsonp",
		]) {
			expect(hasJsonOrEmptyBody(req({ "content-type": ct }))).toBe(false);
		}
		expect(hasJsonOrEmptyBody(req({ "content-length": "5" }))).toBe(false);
		expect(hasJsonOrEmptyBody(req({ "transfer-encoding": "chunked" }))).toBe(false);
	});
});

describe("contentDisposition", () => {
	it("keeps an ASCII fallback and an RFC 5987 UTF-8 name", () => {
		const v = contentDisposition('Reunião "semanal".pdf');
		expect(v).toContain('filename="Reuniao _semanal_.pdf"');
		expect(v).toContain("filename*=UTF-8''Reuni%C3%A3o%20%22semanal%22.pdf");
	});
});

describe("toHttpError", () => {
	it("maps HttpError, domain kinds, zod errors and unknown errors", () => {
		expect(toHttpError(new HttpError(418, "teapot"))).toEqual({ status: 418, message: "teapot" });
		expect(toHttpError(Object.assign(new Error("x"), { kind: "conflict" })).status).toBe(409);
		expect(toHttpError(Object.assign(new Error("x"), { kind: "not_found" })).status).toBe(404);
		expect(toHttpError(Object.assign(new Error("x"), { kind: "validation" })).status).toBe(400);
		const zod = { name: "ZodError", issues: [{ path: ["theme"], message: "Invalid option" }] };
		expect(toHttpError(zod)).toEqual({
			status: 400,
			message: "Dados inválidos: theme: Invalid option",
		});
		expect(toHttpError(new Error("boom"))).toEqual({ status: 500, message: "boom" });
	});
});

describe("readJson", () => {
	let server: http.Server;
	let base: string;
	beforeAll(async () => {
		server = http.createServer(async (req, res) => {
			try {
				const body = await readJson(req, 64);
				json(res, { body });
			} catch (err) {
				const e = err as HttpError;
				json(res, { error: e.message }, e.status ?? 500);
			}
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	const post = (body: string) => fetch(base, { method: "POST", body });

	it("parses objects and treats an empty body as {}", async () => {
		expect(await (await post('{"a":1}')).json()).toEqual({ body: { a: 1 } });
		expect(await (await post("")).json()).toEqual({ body: {} });
	});

	it("rejects invalid JSON and non-objects with 400", async () => {
		expect((await post("{nope")).status).toBe(400);
		expect((await post("[1,2]")).status).toBe(400);
		expect((await post('"str"')).status).toBe(400);
	});

	it("rejects bodies over the limit with 413", async () => {
		const res = await post(JSON.stringify({ big: "x".repeat(200) }));
		expect(res.status).toBe(413);
	});
});
