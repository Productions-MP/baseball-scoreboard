const { buildApiPayload, jsonResponse, readState } = require("./_lib/state");

exports.handler = async function handler() {
  try {
    const state = await readState();
    return jsonResponse(200, buildApiPayload("primary", state));
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: "Unable to load scoreboard state.",
      detail: error.message,
    });
  }
};
