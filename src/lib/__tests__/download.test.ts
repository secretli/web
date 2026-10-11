import { saveBlob } from "../download";

describe("saveBlob", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hands the browser the bytes as application/octet-stream, whatever the sender's type", async () => {
    let handed: Blob | undefined;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      handed = blob;
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    saveBlob(new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "evil.html");

    expect(click).toHaveBeenCalledOnce();
    expect(handed?.type).toBe("application/octet-stream");
    expect(await handed?.text()).toBe("<script>alert(1)</script>");
  });
});
