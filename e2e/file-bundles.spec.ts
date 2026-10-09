import { readFile } from "node:fs/promises";
import { type Download, expect, type Page, test } from "@playwright/test";
import { expectAccessible } from "./axe";

interface TestFile {
  name: string;
  mimeType: string;
  contents: string;
}

async function createFileSecret(
  page: Page,
  files: TestFile[],
  options: { password?: string } = {},
): Promise<string> {
  const { shareUrl } = await createFileSecretLinks(page, files, options);
  return shareUrl;
}

/** Links open once by default, so every bundle made here is one-time. */
async function createFileSecretLinks(
  page: Page,
  files: TestFile[],
  options: { password?: string } = {},
): Promise<{ shareUrl: string; ownerUrl: string }> {
  await page.goto("/share");
  await page.setInputFiles(
    'input[type="file"]',
    files.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.contents),
    })),
  );

  if (options.password) {
    await page.getByRole("button", { name: "Password" }).click();
    await page.fill('input[type="password"]', options.password);
  }

  await page.click('button[type="submit"]');
  await expect(page.getByRole("heading", { name: "Your link is ready" })).toBeVisible({
    timeout: 10000,
  });

  const shareUrl = (await page.getByTestId("share-link").textContent()) ?? "";
  await page.getByRole("button", { name: "Owner link" }).click();
  const ownerUrl = (await page.getByTestId("owner-link").textContent()) ?? "";
  return { shareUrl, ownerUrl };
}

async function revealBundle(page: Page, shareUrl: string, password?: string) {
  await page.goto(shareUrl);
  await expect(page.locator("h1")).toHaveText(/Someone sent you a secret|Your secret/, {
    timeout: 10000,
  });

  if (password) await page.fill('input[type="password"]', password);
  await page.getByRole("button", { name: "Show the files" }).click();
}

/** Downloads one file of several with the button next to it, and checks what arrives. */
async function downloadOneFile(
  page: Page,
  file: TestFile,
  outputPath: (filename: string) => string,
) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 10000 }),
    page.getByRole("button", { name: `Download ${file.name}`, exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(file.name);
  const path = outputPath(file.name);
  await download.saveAs(path);
  await expect(readFile(path, "utf8")).resolves.toBe(file.contents);
}

/** Whether leaving the page now would ask first. */
function leavingAsks(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function downloadBundleFiles(
  page: Page,
  files: TestFile[],
  outputPath: (filename: string) => string,
) {
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));

  await page
    .getByRole("button", { name: files.length > 1 ? "Download files" : "Download file" })
    .click();
  await expect.poll(() => downloads.length, { timeout: 10000 }).toBe(files.length);

  for (const [index, file] of files.entries()) {
    const download = downloads[index];
    expect(download.suggestedFilename()).toBe(file.name);
    const path = outputPath(file.name);
    await download.saveAs(path);
    await expect(readFile(path, "utf8")).resolves.toBe(file.contents);
  }
}

test.describe("File bundle sharing", () => {
  test("creates and retrieves a single-file bundle", async ({ page }, testInfo) => {
    const file = {
      name: "single-note.txt",
      mimeType: "text/plain",
      contents: `single file ${Date.now()}`,
    };

    const shareUrl = await createFileSecret(page, [file]);
    await revealBundle(page, shareUrl);

    await expect(page.locator("h1")).toHaveText("Here's your file", { timeout: 10000 });
    await expect(page.getByTestId("bundle-file-0").getByText(file.name)).toBeVisible();
    await expectAccessible(page);

    await downloadBundleFiles(page, [file], (filename) => testInfo.outputPath(filename));
  });

  test("creates and downloads a multi-file bundle", async ({ page }, testInfo) => {
    const files = [
      { name: "all-alpha.txt", mimeType: "text/plain", contents: "download all alpha" },
      { name: "all-bravo.txt", mimeType: "text/plain", contents: "download all bravo" },
    ];

    const shareUrl = await createFileSecret(page, files);
    await revealBundle(page, shareUrl);
    await expect(page.locator("h1")).toHaveText("Here are your files", { timeout: 10000 });
    await expect(page.getByText("all-alpha.txt")).toBeVisible();
    await expect(page.getByText("all-bravo.txt")).toBeVisible();

    await downloadBundleFiles(page, files, (filename) => testInfo.outputPath(filename));
  });

  test("downloads one file out of several, and the others stay", async ({ page }, testInfo) => {
    const files = [
      { name: "pick-alpha.txt", mimeType: "text/plain", contents: "pick alpha" },
      { name: "pick-bravo.txt", mimeType: "text/plain", contents: "pick bravo" },
      { name: "pick-charlie.txt", mimeType: "text/plain", contents: "pick charlie" },
    ];
    const outputPath = (filename: string) => testInfo.outputPath(filename);

    const shareUrl = await createFileSecret(page, files);
    await revealBundle(page, shareUrl);
    await expect(page.locator("h1")).toHaveText("Here are your files", { timeout: 10000 });

    await downloadOneFile(page, files[1], outputPath);

    // The others stay listed, and can still be downloaded on their own.
    await expect(
      page.getByRole("button", { name: "Save pick-bravo.txt again", exact: true }),
    ).toBeEnabled();
    for (const file of [files[0], files[2]]) {
      await expect(page.getByTestId(`bundle-file-${files.indexOf(file)}`)).toContainText(file.name);
      await expect(
        page.getByRole("button", { name: `Download ${file.name}`, exact: true }),
      ).toBeEnabled();
    }
    await expect(page.getByRole("button", { name: "Download the rest" })).toBeEnabled();
    await expectAccessible(page);

    await downloadOneFile(page, files[2], outputPath);
  });

  test("a one-time bundle asks before leaving until every file is saved", async ({
    page,
  }, testInfo) => {
    const files = [
      { name: "keep-alpha.txt", mimeType: "text/plain", contents: "keep alpha" },
      { name: "keep-bravo.txt", mimeType: "text/plain", contents: "keep bravo" },
    ];
    const outputPath = (filename: string) => testInfo.outputPath(filename);

    const shareUrl = await createFileSecret(page, files);
    await revealBundle(page, shareUrl);
    await expect(page.locator("h1")).toHaveText("Here are your files", { timeout: 10000 });
    await expect(
      page.getByText(/^One-time: files you don't save in the next \d+:\d\d are gone for good\.$/),
    ).toBeVisible();

    await downloadOneFile(page, files[0], outputPath);

    // One file is still only here: leaving asks first, also through the
    // app's own links. The dialog blocks the click until it is answered.
    expect(await leavingAsks(page)).toBe(true);
    const [leaving] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        await dialog.dismiss();
        return dialog;
      }),
      page.getByRole("link", { name: "Share", exact: true }).click(),
    ]);
    expect(leaving.type()).toBe("beforeunload");
    await expect(page.locator("h1")).toHaveText("Here are your files");

    await downloadOneFile(page, files[1], outputPath);

    // Every file is saved: the page lets go.
    await expect(
      page.getByText(
        "Saved. If your browser blocked one of them, use the button next to that file.",
      ),
    ).toBeVisible();
    expect(await leavingAsks(page)).toBe(false);
    await page.getByRole("link", { name: "Share", exact: true }).click();
    await expect(page.locator("h1")).toHaveText("Share a secret");
  });

  test("requires password before listing a protected bundle", async ({ page }, testInfo) => {
    const password = "bundle-password";
    const file = {
      name: "protected.txt",
      mimeType: "text/plain",
      contents: "protected bundle contents",
    };

    const shareUrl = await createFileSecret(page, [file], { password });
    await revealBundle(page, shareUrl, password);

    await expect(page.locator("h1")).toHaveText("Here's your file", { timeout: 10000 });
    await downloadBundleFiles(page, [file], (filename) => testInfo.outputPath(filename));
  });

  test("a one-time bundle cannot start a second retrieval session", async ({ page, context }) => {
    const file = {
      name: "burn.txt",
      mimeType: "text/plain",
      contents: "burn once",
    };

    const shareUrl = await createFileSecret(page, [file]);
    await revealBundle(page, shareUrl);
    await expect(page.locator("h1")).toHaveText("Here's your file", { timeout: 10000 });

    const secondPage = await context.newPage();
    await secondPage.goto(shareUrl);
    await expect(secondPage.locator("h1")).toHaveText("This secret is gone", { timeout: 10000 });
  });

  test("owner link can delete a bundle before recipients retrieve it", async ({
    page,
    context,
  }) => {
    const file = {
      name: "delete-me.txt",
      mimeType: "text/plain",
      contents: "bundle to delete",
    };

    const { shareUrl, ownerUrl } = await createFileSecretLinks(page, [file]);
    // Opening a one-time bundle would use it up, so the owner deletes it unopened.
    await page.goto(ownerUrl);
    await expect(page.locator("h1")).toHaveText("Your secret", { timeout: 10000 });

    await page.getByRole("button", { name: "Delete it now" }).click();
    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByRole("main").getByText("Secret deleted")).toBeVisible({
      timeout: 10000,
    });

    const recipientPage = await context.newPage();
    await recipientPage.goto(shareUrl);
    await expect(recipientPage.locator("h1")).toHaveText("This secret is gone", {
      timeout: 10000,
    });
  });
});
