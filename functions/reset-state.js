const {
  authorizeControlRequest,
  buildApiPayload,
  cloneDefaultState,
  jsonResponse,
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
    const savedState = await writeState(cloneDefaultState());
    return jsonResponse(200, buildApiPayload("primary", savedState));
  } catch (error) {
    return jsonResponse(500, {
      ok: false,
      error: "Unable to reset scoreboard state.",
      detail: error.message,
    });
  }
};
