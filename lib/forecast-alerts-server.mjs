import {
  buildProjectedRankAlerts,
  classifyResolvedForecast,
} from "./forecast-alerts.mjs";

const RANK_COOLDOWN_HOURS = 12;
const DELIVERY_RETRY_MINUTES = 30;
const MAX_DELIVERY_ATTEMPTS = 3;
const MAX_DELIVERY_BATCH = 20;

function validDiscordWebhook(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowedHost = url.hostname === "discord.com" || url.hostname === "discordapp.com";
    if (
      url.protocol !== "https:"
      || !allowedHost
      || !url.pathname.startsWith("/api/webhooks/")
      || url.search
      || url.hash
      || url.username
      || url.password
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function toDatabaseAlert(event, season) {
  return {
    source_forecast_id: event.sourceForecastId ?? null,
    clan_id: event.clanId ?? null,
    clan_name: event.clanName,
    season,
    alert_type: event.alertType,
    severity: event.severity,
    title: event.title,
    detail: event.detail,
    predicted_reputation: event.predictedReputation ?? null,
    actual_reputation: event.actualReputation ?? null,
    absolute_error: event.absoluteError ?? null,
    current_rank: event.currentRank ?? null,
    projected_rank: event.projectedRank ?? null,
    cooldown_key: event.cooldownKey,
    dedupe_key: event.dedupeKey,
    delivery_status: "queued",
    delivery_attempts: 0,
  };
}

function discordPayload(alert) {
  const color = alert.severity === "critical" ? 0xc4604f : 0xc9a24b;
  const fields = [
    { name: "Clan", value: String(alert.clan_name || "Unknown"), inline: true },
    { name: "Season", value: String(alert.season), inline: true },
  ];

  if (alert.current_rank != null && alert.projected_rank != null) {
    fields.push({
      name: "Rank movement",
      value: "#" + alert.current_rank + " → #" + alert.projected_rank,
      inline: true,
    });
  }
  if (alert.predicted_reputation != null) {
    fields.push({
      name: "Projected rep",
      value: Math.round(Number(alert.predicted_reputation)).toLocaleString("en-US"),
      inline: true,
    });
  }
  if (alert.actual_reputation != null) {
    fields.push({
      name: "Actual rep",
      value: Math.round(Number(alert.actual_reputation)).toLocaleString("en-US"),
      inline: true,
    });
  }
  if (alert.absolute_error != null) {
    fields.push({
      name: "Absolute error",
      value: Math.round(Number(alert.absolute_error)).toLocaleString("en-US"),
      inline: true,
    });
  }

  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: String(alert.title || "Forecast alert").slice(0, 256),
      description: String(alert.detail || "").slice(0, 3500),
      color,
      fields,
      timestamp: alert.created_at || new Date().toISOString(),
      footer: { text: "Chaos Tracker · Forecast Action Center" },
    }],
  };
}

async function deliverPendingAlerts(db, nowIso) {
  const webhook = process.env.FORECAST_ALERT_WEBHOOK_URL;
  const { data: pending, error: pendingError } = await db
    .from("clan_forecast_alerts")
    .select("id,season,clan_name,alert_type,severity,title,detail,predicted_reputation,actual_reputation,absolute_error,current_rank,projected_rank,delivery_status,delivery_attempts,last_attempt_at,created_at")
    .in("delivery_status", ["queued", "failed", "not_configured"])
    .lt("delivery_attempts", MAX_DELIVERY_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(MAX_DELIVERY_BATCH);
  if (pendingError) throw pendingError;

  if (!webhook) {
    const queuedIds = (pending || [])
      .filter((alert) => alert.delivery_status === "queued")
      .map((alert) => alert.id);
    if (queuedIds.length) {
      const { error } = await db.from("clan_forecast_alerts")
        .update({ delivery_status: "not_configured", last_error: null })
        .in("id", queuedIds);
      if (error) throw error;
    }
    return { sent: 0, failed: 0, notConfigured: queuedIds.length };
  }

  const endpoint = validDiscordWebhook(webhook);
  if (!endpoint) {
    const queuedIds = (pending || [])
      .filter((alert) => alert.delivery_status !== "sent")
      .map((alert) => alert.id);
    if (queuedIds.length) {
      const { error } = await db.from("clan_forecast_alerts")
        .update({
          delivery_status: "failed",
          last_error: "FORECAST_ALERT_WEBHOOK_URL must be an HTTPS Discord webhook endpoint.",
        })
        .in("id", queuedIds);
      if (error) throw error;
    }
    return { sent: 0, failed: queuedIds.length, notConfigured: 0 };
  }

  const now = new Date(nowIso).getTime();
  const retryBefore = now - DELIVERY_RETRY_MINUTES * 60 * 1000;
  const ready = (pending || []).filter((alert) => (
    !alert.last_attempt_at
    || new Date(alert.last_attempt_at).getTime() <= retryBefore
  ));

  let sent = 0;
  let failed = 0;
  for (const alert of ready) {
    const attemptedAt = new Date().toISOString();
    const attempts = Number(alert.delivery_attempts || 0) + 1;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(discordPayload(alert)),
        signal: AbortSignal.timeout(8000),
      });
      const update = response.ok
        ? {
          delivery_status: "sent",
          delivery_attempts: attempts,
          last_attempt_at: attemptedAt,
          sent_at: attemptedAt,
          last_error: null,
        }
        : {
          delivery_status: "failed",
          delivery_attempts: attempts,
          last_attempt_at: attemptedAt,
          sent_at: null,
          last_error: "Discord webhook returned HTTP " + response.status + ".",
        };
      const { error } = await db.from("clan_forecast_alerts").update(update).eq("id", alert.id);
      if (error) throw error;
      if (response.ok) sent += 1;
      else failed += 1;
    } catch (error) {
      const { error: updateError } = await db.from("clan_forecast_alerts")
        .update({
          delivery_status: "failed",
          delivery_attempts: attempts,
          last_attempt_at: attemptedAt,
          sent_at: null,
          last_error: String(error?.message || "Discord delivery failed").slice(0, 300),
        })
        .eq("id", alert.id);
      if (updateError) {
        console.warn("Could not persist forecast alert delivery failure:", updateError.message);
      }
      failed += 1;
    }
  }

  return { sent, failed, notConfigured: 0 };
}

export async function processForecastAlerts(db, season, effectiveNow, currentClans = []) {
  const events = [];
  const { data: resolved, error: resolvedError } = await db
    .from("clan_forecasts")
    .select("id,clan_id,season,base_reputation,forecast_reputation,actual_reputation,absolute_error,resolution_status,clans!inner(name)")
    .eq("season", season)
    .eq("resolution_status", "resolved")
    .eq("resolved_at", effectiveNow);
  if (resolvedError) throw resolvedError;

  for (const forecast of resolved || []) {
    events.push(...classifyResolvedForecast(forecast));
  }

  const recentCutoff = new Date(
    new Date(effectiveNow).getTime() - 6 * 60 * 60 * 1000,
  ).toISOString();
  const { data: currentForecasts, error: forecastsError } = await db
    .from("clan_forecasts")
    .select("id,clan_id,forecast_at,target_at,forecast_reputation,history_hours,resolution_status")
    .eq("season", season)
    .eq("resolution_status", "pending")
    .gte("forecast_at", recentCutoff)
    .lte("forecast_at", effectiveNow)
    .order("forecast_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1000);
  if (forecastsError) throw forecastsError;

  events.push(...buildProjectedRankAlerts(currentClans, currentForecasts || [], {
    now: effectiveNow,
    rankCooldownHours: RANK_COOLDOWN_HOURS,
  }));

  let inserted = [];
  if (events.length) {
    const cooldownKeys = [...new Set(events.map((event) => event.cooldownKey))];
    const cooldownCutoff = new Date(
      new Date(effectiveNow).getTime() - RANK_COOLDOWN_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const { data: recentAlerts, error: cooldownError } = await db
      .from("clan_forecast_alerts")
      .select("cooldown_key")
      .in("cooldown_key", cooldownKeys)
      .gte("created_at", cooldownCutoff);
    if (cooldownError) throw cooldownError;

    const coolingDown = new Set((recentAlerts || []).map((row) => row.cooldown_key));
    const candidates = events
      .filter((event) => !coolingDown.has(event.cooldownKey))
      .map((event) => toDatabaseAlert(event, season));

    if (candidates.length) {
      const { data, error } = await db.from("clan_forecast_alerts")
        .insert(candidates)
        .select("id,delivery_status,delivery_attempts");
      if (error) throw error;
      inserted = data || [];
    }
  }

  const delivery = await deliverPendingAlerts(db, effectiveNow);
  return {
    created: inserted.length,
    sent: delivery.sent,
    failed: delivery.failed,
    not_configured: delivery.notConfigured,
    rank_alerts_considered: events.filter((event) => event.alertType.startsWith("projected_top_ten_")).length,
  };
}
