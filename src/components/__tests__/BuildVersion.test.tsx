import { render, screen, waitFor } from "@testing-library/react";
import BuildVersion from "../BuildVersion";

const WEB_COMMIT = "5c6577a3d0b6f7e9c1a2b3c4d5e6f708192a3b4c";
const SERVER_COMMIT = "860030f3e948ed3644c2498022d613e122796147";

function serveVersion(response: Response | Error) {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  if (response instanceof Error) fetchMock.mockRejectedValue(response);
  else fetchMock.mockResolvedValue(response);
  return fetchMock;
}

describe("BuildVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("shows the web and server commits, each linked to its repository", async () => {
    vi.stubEnv("VITE_BUILD_VERSION", WEB_COMMIT);
    const fetchMock = serveVersion(new Response(JSON.stringify({ version: SERVER_COMMIT })));

    render(<BuildVersion />);

    const server = await screen.findByRole("link", { name: "server 860030f" });
    expect(server.getAttribute("href")).toBe(
      `https://github.com/secretli/server/commit/${SERVER_COMMIT}`,
    );
    const web = screen.getByRole("link", { name: "web 5c6577a" });
    expect(web.getAttribute("href")).toBe(`https://github.com/secretli/web/commit/${WEB_COMMIT}`);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/version", expect.anything());
  });

  it("shows local builds without links", async () => {
    serveVersion(new Response(JSON.stringify({ version: "dev" })));

    render(<BuildVersion />);

    await screen.findByText("server dev");
    expect(screen.getByText("web dev")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("still shows the web build when the server can't be reached", async () => {
    vi.stubEnv("VITE_BUILD_VERSION", WEB_COMMIT);
    const fetchMock = serveVersion(new TypeError("offline"));

    const { container } = render(<BuildVersion />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("web 5c6577a");
  });
});
