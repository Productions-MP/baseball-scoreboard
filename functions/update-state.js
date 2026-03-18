const {
  authorizeControlRequest,
  buildApiPayload,
  jsonResponse,
  mergeState,
  parseJsonBody,
  readState,
  writeState,
} = require("./_lib/state");

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "Method not allowed.",
    });
  }

  const authError = authorizeControlRequest(event);

  if (authError) {
    return authError;
  }

  try {
    const payload = parseJsonBody(event);
    const currentState = await readState();
    const nextState = mergeState(currentState, payload);
    const savedState = await writeState(nextState);

    return jsonResponse(200, buildApiPayload("primary", savedState));
  } catch (error) {
    return jsonResponse(400, {
      ok: false,
      error: "Unable to save scoreboard state.",
      detail: error.message,
    });
  }
};
