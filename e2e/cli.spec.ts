import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

/**
 * The command-line client (secretli/cli) against the web app, both talking to
 * the same server: links made by one must open in the other. SECRETLI_CLI
 * points at a secretli binary; without one these tests are skipped.
 */
const CLI = process.env.SECRETLI_CLI ?? "";

test.describe("Command-line client", () => {
  test.skip(!CLI, "SECRETLI_CLI is not set");

  test("a link made by the CLI opens in the browser", async ({ page, baseURL }) => {
    const text = `from the cli ${Date.now()}`;
    const { stdout } = await run(CLI, [
      "share",
      "-t",
      text,
      "-e",
      "5m",
      "-q",
      "--server",
      baseURL ?? "",
    ]);
    const link = stdout.trim();
    expect(link).toContain("/s#");

    await page.goto(link);
    await expect(page.locator("h1")).toHaveText("Someone sent you a secret", { timeout: 10000 });
    await page.getByRole("button", { name: /^Reveal/ }).click();
    await expect(page.locator("h1")).toHaveText("Here's your secret", { timeout: 10000 });
    await expect(page.locator("pre")).toHaveText(text);
  });

  test("a link made in the browser opens with the CLI, and the owner link knows", async ({
    page,
  }) => {
    const text = `from the browser ${Date.now()}`;
    await page.goto("/share");
    await page.fill("#secret-text", text);
    await page.click('button[type="submit"]');
    await expect(page.getByRole("heading", { name: "Your link is ready" })).toBeVisible({
      timeout: 10000,
    });
    const link = (await page.getByTestId("share-link").textContent()) ?? "";
    await page.getByRole("button", { name: "Owner link" }).click();
    const ownerLink = (await page.getByTestId("owner-link").textContent()) ?? "";

    // Piped: stdout is the text alone, exactly as shared.
    const opened = await run(CLI, ["open", link]);
    expect(opened.stdout).toBe(text);
    expect(opened.stderr).toContain("A one-time text secret");

    // The owner's status says it was opened, and exits 4.
    const status = await run(CLI, ["status", ownerLink]).catch((err) => err);
    expect(status.code).toBe(4);
    expect(status.stdout).toContain("Your secret was opened");
  });
});
