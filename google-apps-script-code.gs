const LOG_HEADERS = [
  "received_at",
  "session_id",
  "participant_id",
  "question_index",
  "task_id",
  "difficulty",
  "event_type",
  "shown_at",
  "event_at",
  "response_time_ms",
  "is_correct",
  "idle_detected",
  "idle_count",
  "idle_total_ms",
  "rest_duration_ms",
  "note",
  "target_value",
  "choice_value",
  "choice_count",
  "event_id"
];

const SESSION_HEADERS = [
  "created_at",
  "session_id",
  "participant_id",
  "timer_visible",
  "rest_seconds",
  "max_questions",
  "task_type",
  "user_agent",
  "page_url",
  "event_id"
];

const DELIVERY_HEADERS = [
  "received_at",
  "batch_id",
  "accepted",
  "duplicates"
];

const SELF_REPORT_HEADERS = [
  "received_at",
  "report_id",
  "session_id",
  "participant_id",
  "submitted_at",
  "end_event_type",
  "end_reason",
  "concentration_rating",
  "fatigue_rating",
  "boredom_rating",
  "difficulty_rating",
  "external_interruption",
  "other_reason",
  "response_status",
  "app_version",
  "event_id"
];

const OBSERVER_SESSION_HEADERS = [
  "created_at",
  "observer_session_id",
  "participant_id",
  "observer_id",
  "experiment_run",
  "app_version",
  "user_agent",
  "page_url"
];

const OBSERVER_EVENT_HEADERS = [
  "received_at",
  "event_id",
  "observer_session_id",
  "participant_id",
  "observer_id",
  "experiment_run",
  "event_at",
  "elapsed_ms",
  "question_index",
  "event_type",
  "event_label",
  "note",
  "target_event_id",
  "app_version",
  "page_url"
];

function doGet(e) {
  const parameters = (e && e.parameter) || {};
  if (parameters.action === "status" && parameters.batch_id) {
    const callback = safeCallback_(parameters.callback);
    const result = getDeliveryStatus_(String(parameters.batch_id));
    return ContentService
      .createTextOutput(callback + "(" + JSON.stringify(result) + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput("learning log collector is running")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const type = payload.type || "";
    const data = payload.data || {};
    let result = { accepted: 0, duplicates: 0 };

    if (type === "batch") {
      const batchId = String(data.batch_id || "");
      if (batchId && hasDelivery_(batchId)) {
        result = { accepted: 0, duplicates: Array.isArray(data.records) ? data.records.length : 0 };
      } else {
        result = appendBatch_(Array.isArray(data.records) ? data.records : []);
        SpreadsheetApp.flush();
        const recordCount = Array.isArray(data.records) ? data.records.length : 0;
        if (batchId && result.accepted + result.duplicates === recordCount) {
          recordDelivery_(batchId, result);
        }
      }
    } else if (type === "session") {
      ensureEventId_(type, data);
      result = appendRecords_("sessions", SESSION_HEADERS, [data], "session_id");
    } else if (type === "log") {
      ensureEventId_(type, data);
      result = appendRecords_("logs", LOG_HEADERS, [data], "event_id");
    } else if (type === "self_report") {
      data.received_at = new Date().toISOString();
      ensureEventId_(type, data);
      result = appendRecords_("self_reports", SELF_REPORT_HEADERS, [data], "event_id");
    } else if (type === "observer_session") {
      if (!data.created_at) data.created_at = new Date().toISOString();
      result = appendRecords_("observer_sessions", OBSERVER_SESSION_HEADERS, [data]);
    } else if (type === "observer_event") {
      data.received_at = new Date().toISOString();
      result = appendRecords_("observer_events", OBSERVER_EVENT_HEADERS, [data], "event_id");
    } else {
      appendRecords_("errors", ["received_at", "message", "raw"], [{
        received_at: new Date().toISOString(),
        message: "unknown payload type",
        raw: JSON.stringify(payload)
      }]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, ...result }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    appendRecords_("errors", ["received_at", "message", "raw"], [{
      received_at: new Date().toISOString(),
      message: String(error && error.message ? error.message : error),
      raw: (e && e.postData && e.postData.contents) || ""
    }]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: false }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function appendBatch_(records) {
  const sessions = [];
  const logs = [];
  const selfReports = [];

  records.forEach((item) => {
    if (!item || !item.type || !item.data) return;
    ensureEventId_(item.type, item.data);
    if (item.type === "session") sessions.push(item.data);
    if (item.type === "log") logs.push(item.data);
    if (item.type === "self_report") selfReports.push(item.data);
  });

  const sessionResult = appendRecords_("sessions", SESSION_HEADERS, sessions, "session_id");
  const logResult = appendRecords_("logs", LOG_HEADERS, logs, "event_id");
  const selfReportResult = appendRecords_("self_reports", SELF_REPORT_HEADERS, selfReports, "event_id");
  return {
    accepted: sessionResult.accepted + logResult.accepted + selfReportResult.accepted,
    duplicates: sessionResult.duplicates + logResult.duplicates + selfReportResult.duplicates
  };
}

function recordDelivery_(batchId, result) {
  appendRecords_("deliveries", DELIVERY_HEADERS, [{
    received_at: new Date().toISOString(),
    batch_id: batchId,
    accepted: result.accepted,
    duplicates: result.duplicates
  }], "batch_id");
  SpreadsheetApp.flush();
}

function hasDelivery_(batchId) {
  return getDeliveryStatus_(batchId).ok;
}

function getDeliveryStatus_(batchId) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName("deliveries");
  if (!sheet || sheet.getLastRow() < 2) {
    return { ok: false, batch_id: batchId, accepted: 0, duplicates: 0 };
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const batchIdIndex = headers.indexOf("batch_id");
  const acceptedIndex = headers.indexOf("accepted");
  const duplicatesIndex = headers.indexOf("duplicates");
  if (batchIdIndex < 0 || acceptedIndex < 0 || duplicatesIndex < 0) {
    return { ok: false, batch_id: batchId, accepted: 0, duplicates: 0 };
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const row = rows.find((values) => String(values[batchIdIndex]) === batchId);
  return row
    ? {
        ok: true,
        batch_id: batchId,
        accepted: Number(row[acceptedIndex] || 0),
        duplicates: Number(row[duplicatesIndex] || 0)
      }
    : { ok: false, batch_id: batchId, accepted: 0, duplicates: 0 };
}

function safeCallback_(value) {
  const callback = String(value || "learningLogAcknowledgement");
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)
    ? callback
    : "learningLogAcknowledgement";
}

function ensureEventId_(type, record) {
  if (record.event_id) return;
  if (type === "session") {
    record.event_id = String(record.session_id || "") + ":session";
    return;
  }
  record.event_id = [
    record.session_id || "",
    record.event_type || type,
    record.question_index || "",
    record.event_at || record.received_at || ""
  ].join(":");
}

function appendRecords_(sheetName, headers, records, uniqueHeader) {
  if (!records || records.length === 0) return { accepted: 0, duplicates: 0 };
  const sheet = getOrCreateSheet_(sheetName, headers);
  const uniqueIndex = uniqueHeader ? headers.indexOf(uniqueHeader) : -1;
  const existing = new Set();

  if (uniqueIndex >= 0 && sheet.getLastRow() > 1) {
    sheet.getRange(2, uniqueIndex + 1, sheet.getLastRow() - 1, 1)
      .getValues()
      .forEach((row) => {
        if (row[0] !== "") existing.add(String(row[0]));
      });
  }

  const acceptedRows = [];
  let duplicates = 0;
  records.forEach((record) => {
    const uniqueValue = uniqueIndex >= 0 ? String(record[uniqueHeader] || "") : "";
    if (uniqueValue && existing.has(uniqueValue)) {
      duplicates += 1;
      return;
    }
    if (uniqueValue) existing.add(uniqueValue);
    acceptedRows.push(headers.map((header) => valueForCell_(record[header])));
  });

  if (acceptedRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, acceptedRows.length, headers.length)
      .setValues(acceptedRows);
  }
  return { accepted: acceptedRows.length, duplicates };
}

function getOrCreateSheet_(sheetName, headers) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const columnCount = sheet.getLastColumn();
  if (columnCount === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }

  const existingHeaders = sheet.getRange(1, 1, 1, columnCount).getValues()[0];
  if (existingHeaders.join("\u0001") !== headers.join("\u0001")) {
    alignSheetHeaders_(sheet, existingHeaders, headers);
  }
  sheet.setFrozenRows(1);

  return sheet;
}

// Keep formulas, formatting and additional research columns in place.
// The retired name is used only to migrate existing sheets.
function alignSheetHeaders_(sheet, oldHeaders, newHeaders) {
  const retiredIndexes = [];
  if (sheet.getName() === "logs") {
    oldHeaders.forEach((header, index) => {
      if (header === "block_name") retiredIndexes.push(index + 1);
    });
  }
  if (retiredIndexes.length) {
    // Copy successfully before deleting any columns; a failed copy aborts migration.
    const backup = sheet.copyTo(SpreadsheetApp.getActiveSpreadsheet());
    backup.setName("logs_backup_" + Utilities.getUuid());
    retiredIndexes.reverse().forEach((column) => sheet.deleteColumn(column));
  }
  // Move whole columns instead of reading and rewriting cell values.
  newHeaders.forEach((header, index) => {
    const count = sheet.getLastColumn();
    const current = count ? sheet.getRange(1, 1, 1, count).getValues()[0] : [];
    const source = current.indexOf(header);
    if (source === -1) {
      if (index + 1 > sheet.getMaxColumns()) sheet.insertColumnAfter(sheet.getMaxColumns());
      else sheet.insertColumnBefore(index + 1);
      sheet.getRange(1, index + 1).setValue(header);
    } else if (source !== index) {
      sheet.moveColumns(sheet.getRange(1, source + 1, sheet.getMaxRows(), 1), index + 1);
    }
  });
}

// Run manually before use; doPost uses the same lock during automatic migration.
function cleanUpCurrentLogSheets() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    [["logs", LOG_HEADERS], ["sessions", SESSION_HEADERS]].forEach(([sheetName, headers]) => {
      const sheet = spreadsheet.getSheetByName(sheetName);
      if (!sheet || sheet.getLastColumn() === 0) return;
      const oldHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      alignSheetHeaders_(sheet, oldHeaders, headers);
      sheet.setFrozenRows(1);
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function valueForCell_(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
