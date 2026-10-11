import { displayName, downloadName } from "../fileNames";

const c = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

describe("received file names", () => {
  it.each([
    ["notes.txt", "notes.txt", "notes.txt"],
    [`invoice${c(0x202e)}txt.exe`, "invoice?txt.exe", "invoice_txt.exe"],
    [`a${c(0x2066)}b${c(0x2069)}c${c(0x200f)}d${c(0x200b)}e`, "a?b?c?d?e", "a_b_c_d_e"],
    [`title${c(0x1b)}]0;x${c(0x07)}.txt`, "title?]0;x?.txt", "title_]0;x_.txt"],
    [`lone${c(0xd800)}surrogate`, "lone?surrogate", "lone_surrogate"],
    ["naïve résumé.pdf", "naïve résumé.pdf", "naïve résumé.pdf"],
    [
      `${c(0x1f468, 0x200d, 0x1f469)}.png`,
      `${c(0x1f468, 0x200d, 0x1f469)}.png`,
      `${c(0x1f468, 0x200d, 0x1f469)}.png`,
    ],
    [
      `${c(0x645, 0x6cc, 0x200c, 0x62e)}.txt`,
      `${c(0x645, 0x6cc, 0x200c, 0x62e)}.txt`,
      `${c(0x645, 0x6cc, 0x200c, 0x62e)}.txt`,
    ],
  ])("%j shows as %j and saves as %j", (name, shown, saved) => {
    expect(displayName(name)).toBe(shown);
    expect(downloadName(name)).toBe(saved);
  });
});
