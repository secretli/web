import { TEXT_SHOWN_BYTES, textToShow } from "../textPreview";

describe("textToShow", () => {
  it("shows a text of up to TEXT_SHOWN_BYTES whole", async () => {
    const text = "x".repeat(TEXT_SHOWN_BYTES);
    expect(await textToShow(new Blob([text]))).toEqual({ text, complete: true });
  });

  it("shows the beginning of a longer one, without a character the cut splits", async () => {
    // "ü" is two bytes; the second one lies past the cut.
    const text = `${"x".repeat(TEXT_SHOWN_BYTES - 1)}ü and more`;
    const shown = await textToShow(new Blob([text]));
    expect(shown.complete).toBe(false);
    expect(shown.text).toBe("x".repeat(TEXT_SHOWN_BYTES - 1));
  });
});
