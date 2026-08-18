import { UploadsService } from "./uploads.service";
import { UploadsController } from "./uploads.controller";
import { UploadPurpose } from "./dto/presign-upload.dto";

/* ---------------------------------------------------------------------------
   Identity documents.

   These were served from a public R2 origin: a CNIC was readable by anyone
   holding the link, and those links are not secret — they sit in the
   database, render in the ops console, and travel through screenshots and
   support threads. A UUID in the path is obscurity, not access control.

   The rules these tests hold in place:
     - a KYC upload never yields a public URL
     - a signed read is short-lived
     - only an ADMIN, or the document's own uploader, can mint one
     - the key cannot be pointed at anything outside a private purpose
   --------------------------------------------------------------------------- */

const CONFIG = (over: Record<string, string> = {}) =>
  ({
    get: (k: string, d = "") =>
      ({
        R2_ACCOUNT_ID: "acct",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "novago-uploads",
        R2_PUBLIC_URL_BASE: "https://pub-test.r2.dev",
        ...over,
      })[k] ?? d,
  }) as any;

describe("UploadsService — KYC objects are private", () => {
  it("returns an object KEY for a KYC document, never a public URL", async () => {
    const svc = new UploadsService(CONFIG());
    const res = await svc.createPresignedUpload("driver-1", UploadPurpose.KYC_DOC, "image/jpeg", "cnic.jpg");
    expect(res.isPrivate).toBe(true);
    expect(res.publicUrl).toBe(res.key);
    expect(res.publicUrl).not.toMatch(/^https?:\/\//);
    // The key carries the uploader's id as its second segment — that is what
    // the ownership check later reads, so it must not drift.
    expect(res.key.startsWith("kyc-doc/driver-1/")).toBe(true);
  });

  it("still returns a real public URL for genuinely public content", async () => {
    const svc = new UploadsService(CONFIG());
    const res = await svc.createPresignedUpload("shop-1", UploadPurpose.MENU_ITEM, "image/jpeg", "biryani.jpg");
    expect(res.isPrivate).toBe(false);
    expect(res.publicUrl).toBe(`https://pub-test.r2.dev/${res.key}`);
  });

  it("signs a SHORT-LIVED read, so a URL lifted from a network tab is stale by the time it is used", async () => {
    const svc = new UploadsService(CONFIG());
    const url = await svc.signedViewUrl("kyc-doc/driver-1/abc.jpg");
    // AWS SigV4 puts the lifetime in the query string; assert the value we
    // promise rather than merely that the URL was signed at all.
    expect(url).toContain("X-Amz-Expires=120");
    expect(url).toContain("X-Amz-Signature=");
  });

  it("accepts a legacy absolute pub-….r2.dev URL so existing applications stay reviewable", async () => {
    const svc = new UploadsService(CONFIG());
    const url = await svc.signedViewUrl("https://pub-test.r2.dev/kyc-doc/driver-1/legacy.jpg");
    expect(url).toContain("kyc-doc/driver-1/legacy.jpg");
  });

  it("refuses a key outside a private purpose, and refuses traversal", async () => {
    const svc = new UploadsService(CONFIG());
    await expect(svc.signedViewUrl("menu-item/shop-1/a.jpg")).rejects.toThrow(/not readable/i);
    await expect(svc.signedViewUrl("kyc-doc/../../etc/passwd")).rejects.toThrow(/not readable/i);
    await expect(svc.signedViewUrl("/kyc-doc/driver-1/a.jpg")).rejects.toThrow(/not readable/i);
  });
});

describe("UploadsController.view — who may open a document", () => {
  const controller = () => {
    const uploads = { signedViewUrl: jest.fn().mockResolvedValue("https://signed.example/doc") } as any;
    return { c: new UploadsController(uploads, {} as any), uploads };
  };
  const KEY = "kyc-doc/driver-1/abc.jpg";

  it("lets the OWNER open their own document", async () => {
    const { c, uploads } = controller();
    await expect(c.view({ userId: "driver-1", role: "DRIVER" }, { key: KEY })).resolves.toEqual({
      url: "https://signed.example/doc",
      expiresInSeconds: 120,
    });
    expect(uploads.signedViewUrl).toHaveBeenCalledWith(KEY);
  });

  it("lets an ADMIN open anyone's document — reviewing them is the job", async () => {
    const { c } = controller();
    await expect(c.view({ userId: "ops-7", role: "ADMIN" }, { key: KEY })).resolves.toHaveProperty("url");
  });

  it("REFUSES another driver", async () => {
    const { c, uploads } = controller();
    await expect(c.view({ userId: "driver-2", role: "DRIVER" }, { key: KEY })).rejects.toThrow(/isn't yours/i);
    expect(uploads.signedViewUrl).not.toHaveBeenCalled();
  });

  it("REFUSES a customer", async () => {
    const { c } = controller();
    await expect(c.view({ userId: "rider-9", role: "RIDER" }, { key: KEY })).rejects.toThrow(/isn't yours/i);
  });

  it("checks ownership on a legacy absolute URL too, not just a bare key", async () => {
    const { c } = controller();
    const legacy = "https://pub-test.r2.dev/kyc-doc/driver-1/abc.jpg";
    await expect(c.view({ userId: "driver-2", role: "DRIVER" }, { key: legacy })).rejects.toThrow(/isn't yours/i);
    await expect(c.view({ userId: "driver-1", role: "DRIVER" }, { key: legacy })).resolves.toHaveProperty("url");
  });
});
