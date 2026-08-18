/* ---------------------------------------------------------------------------
   Two riders, one job.

   Several riders are now shown the same trip at once, so the accept race is
   not a rare interleaving any more — it is what happens on every dispatch.
   The guarantee lives in one statement:

     updateMany({ where: { id, status: "MATCHING", driverId: null },
                  data:  { status: "MATCHED", driverId } })

   The database serialises the two updates. The first matches one row and
   claims it; the second matches zero, because driverId is no longer null.

   These tests pin that shape. A future refactor to read-then-write would hand
   the same pickup to two riders on a busy evening, and neither would find out
   until they both arrived.
   --------------------------------------------------------------------------- */

describe("accept is an atomic claim on an unclaimed row", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "trips.service.ts"),
    "utf8",
  );

  it("guards on driverId: null, not on a pre-assigned driver", () => {
    // The old guard was `driverId` — the trip was reserved for one rider up
    // front. With a broadcast there is nobody to compare against until the
    // winner writes themselves in.
    expect(source).toMatch(
      /updateMany\(\{\s*where:\s*\{\s*id:\s*tripId,\s*status:\s*"MATCHING",\s*driverId:\s*null\s*\}/s,
    );
  });

  it("writes the winning driverId in the same statement that claims the row", () => {
    expect(source).toMatch(
      /where:\s*\{\s*id:\s*tripId,\s*status:\s*"MATCHING",\s*driverId:\s*null\s*\},\s*data:\s*\{\s*status:\s*"MATCHED",\s*driverId,/s,
    );
  });

  it("treats a zero-row update as losing the race, not as an error", () => {
    expect(source).toMatch(/claimed\.count === 0/);
    expect(source).toMatch(/ConflictException\(\s*"Another rider took this one first\."/);
  });

  it("never re-reads and then writes — that is the shape this replaces", () => {
    // A findUnique immediately followed by an unguarded status write inside
    // acceptTrip would reintroduce the race.
    const accept = source.slice(source.indexOf("async acceptTrip"), source.indexOf("async declineTrip"));
    expect(accept).not.toMatch(/prisma\.trip\.update\(\{[^}]*status:\s*"MATCHED"/s);
  });

  it("tells the losing riders so their card disappears", () => {
    expect(source).toMatch(/trip:offerTaken/);
  });
});

describe("broadcast dispatch", () => {
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "trips.service.ts"),
    "utf8",
  );

  it("offers to several riders and leaves the row unclaimed", () => {
    expect(source).toMatch(/offerToDrivers\(tripId/);
    expect(source).toMatch(/driverId:\s*null,\s*offerCount/);
  });

  it("declining excludes only that rider, and does not re-match", () => {
    const decline = source.slice(source.indexOf("async declineTrip"), source.indexOf("async markArrived"));
    // Re-matching on a decline would yank the job from riders still looking.
    expect(decline).not.toMatch(/attemptMatch/);
    expect(decline).toMatch(/excludedDriversStore\.add/);
  });

  it("only the timeout re-matches, and only while still unclaimed", () => {
    expect(source).toMatch(/current\.driverId === null/);
  });
});
