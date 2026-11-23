// ============================================================
// ALLPA · FirmaEC · iniciar firma · V8.4.1
// Compatible con versiones V1, V2, V3...
//
// Secrets requeridos:
// FIRMAEC_API_URL
// FIRMAEC_API_KEY
// FIRMAEC_SISTEMA
// FIRMAEC_PRE=true|false
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
    },
  });
}

async function sha256Hex(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array) {
  const step = 0x8000;
  let out = "";

  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }

  return btoa(out);
}

function normalizeToken(raw: string) {
  const value = raw.trim();

  try {
    const parsed = JSON.parse(value);

    if (typeof parsed === "string") {
      return parsed.trim();
    }

    return String(
      parsed?.token ??
      parsed?.jwt ??
      parsed?.result ??
      parsed?.data?.token ??
      ""
    ).trim();
  } catch {
    return value.replace(/^"|"$/g, "").trim();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  if (req.method !== "POST") {
    return json({ error: "Método no permitido." }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const userClient = createClient(
      supabaseUrl,
      anonKey,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      },
    );

    const admin = createClient(
      supabaseUrl,
      serviceKey,
    );

    const {
      data: auth,
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !auth?.user) {
      return json({ error: "Sesión inválida." }, 401);
    }

    const user = auth.user;
    const body = await req.json();

    const documentoFirmaId =
      String(body?.documento_firma_id ?? "").trim();

    if (!documentoFirmaId) {
      return json(
        { error: "Falta documento_firma_id." },
        400,
      );
    }

    const {
      data: doc,
      error: docError,
    } = await admin
      .from("phdu_documentos_firma")
      .select("*")
      .eq("id", documentoFirmaId)
      .single();

    if (docError || !doc) {
      return json(
        { error: "No existe la versión documental." },
        404,
      );
    }

    if (
      ["FIRMADO", "SUSTITUIDO", "ANULADO"].includes(doc.estado)
    ) {
      return json(
        {
          error:
            `La versión V${doc.version} está en estado ${doc.estado} y no puede volver a firmarse.`,
        },
        409,
      );
    }

    if (
      ![
        "FINALIZADO",
        "PENDIENTE_FIRMA",
        "FIRMA_PARCIAL",
        "ERROR",
      ].includes(doc.estado)
    ) {
      return json(
        {
          error:
            `La versión V${doc.version} todavía no está finalizada para firma.`,
        },
        409,
      );
    }

    // Leer TODAS las firmas en orden.
    const {
      data: firmas,
      error: firmasError,
    } = await admin
      .from("phdu_firmas_documento")
      .select("*")
      .eq("documento_firma_id", documentoFirmaId)
      .order("orden", { ascending: true });

    if (firmasError || !firmas?.length) {
      return json(
        { error: "La versión no tiene firmantes configurados." },
        409,
      );
    }

    // Solo se puede firmar el primer turno que aún no esté FIRMADO.
    const firma = firmas.find(
      (f) => f.estado !== "FIRMADA" && f.estado !== "ANULADA",
    );

    if (!firma) {
      return json(
        { error: "No existen firmas pendientes." },
        409,
      );
    }

    if (firma.estado === "EN_FIRMAEC") {
      return json(
        {
          error:
            "Este turno ya fue enviado a FirmaEC y está pendiente de retorno.",
        },
        409,
      );
    }

    if (
      !["PENDIENTE", "ERROR"].includes(firma.estado)
    ) {
      return json(
        {
          error:
            `El turno de firma está en estado ${firma.estado}.`,
        },
        409,
      );
    }

    if (firma.firmante_id !== user.id) {
      return json(
        {
          error:
            "Este turno de firma corresponde a otro usuario.",
        },
        403,
      );
    }

    const {
      data: identidad,
    } = await admin
      .from("phdu_firma_identidades")
      .select("cedula,habilitado")
      .eq("user_id", user.id)
      .single();

    if (
      !identidad?.habilitado ||
      !identidad?.cedula
    ) {
      return json(
        {
          error:
            "El usuario no tiene una identidad de FirmaEC habilitada.",
        },
        409,
      );
    }

    // En V2+, pdf_actual_path debe contener la salida de la firma previa
    // si ya hubo una firma. Para la primera firma se utiliza el original.
    const pdfPath =
      doc.pdf_actual_path ||
      doc.pdf_original_path;

    if (!pdfPath) {
      return json(
        {
          error:
            `El PDF de la versión V${doc.version} todavía no ha sido preparado.`,
        },
        409,
      );
    }

    const {
      data: pdfBlob,
      error: pdfError,
    } = await admin.storage
      .from("allpa-firma")
      .download(pdfPath);

    if (pdfError || !pdfBlob) {
      return json(
        { error: "No se pudo recuperar el PDF." },
        500,
      );
    }

    const pdfBytes =
      new Uint8Array(
        await pdfBlob.arrayBuffer(),
      );

    const pdfHash =
      await sha256Hex(pdfBytes);

    const pdf64 =
      bytesToBase64(pdfBytes);

    const apiUrl =
      (Deno.env.get("FIRMAEC_API_URL") ?? "")
        .replace(/\/+$/, "");

    const apiKey =
      Deno.env.get("FIRMAEC_API_KEY") ?? "";

    const sistema =
      Deno.env.get("FIRMAEC_SISTEMA") ?? "";

    const pre =
      (Deno.env.get("FIRMAEC_PRE") ?? "true")
        .toLowerCase() === "true";

    if (
      !apiUrl ||
      !apiKey ||
      !sistema
    ) {
      return json(
        {
          error:
            "FirmaEC no está configurado en el servidor.",
        },
        503,
      );
    }

    // El nombre incluye versión y orden de firma:
    // evita mezclar retornos de V1 con V2.
    const nombreDocumento =
      firma.firmaec_nombre_documento ||
      [
        "ALLPA",
        doc.tipo_documento,
        doc.referencia_id,
        `V${doc.version}`,
        `F${firma.orden}`,
        firma.id,
      ].join("_") + ".pdf";

    const firmaecResp =
      await fetch(
        `${apiUrl}/servicio/documentos`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": apiKey,
          },
          body: JSON.stringify({
            sistema,
            cedula: identidad.cedula,
            documentos: [
              {
                nombre: nombreDocumento,
                documento: pdf64,
              },
            ],
          }),
        },
      );

    const raw =
      await firmaecResp.text();

    if (!firmaecResp.ok) {
      await admin
        .from("phdu_firmas_documento")
        .update({
          estado: "ERROR",
          error:
            `FirmaEC HTTP ${firmaecResp.status}: ${raw.slice(0, 1000)}`,
          actualizado_en:
            new Date().toISOString(),
        })
        .eq("id", firma.id);

      await admin
        .from("phdu_documentos_firma")
        .update({
          estado: "ERROR",
          actualizado_en:
            new Date().toISOString(),
        })
        .eq("id", doc.id);

      return json(
        {
          error:
            "FirmaEC rechazó la solicitud.",
          detalle: raw,
        },
        502,
      );
    }

    const token =
      normalizeToken(raw);

    if (
      !token ||
      token.split(".").length < 2
    ) {
      return json(
        {
          error:
            "FirmaEC no devolvió un token válido.",
          detalle: raw,
        },
        502,
      );
    }

    const tokenHash =
      await sha256Hex(
        new TextEncoder().encode(token),
      );

    await admin
      .from("phdu_firmas_documento")
      .update({
        estado: "EN_FIRMAEC",
        firmaec_nombre_documento:
          nombreDocumento,
        firmaec_token_hash:
          tokenHash,
        solicitud_en:
          new Date().toISOString(),
        error: null,
        actualizado_en:
          new Date().toISOString(),
      })
      .eq("id", firma.id);

    const yaFirmadas =
      firmas.filter(
        (f) => f.estado === "FIRMADA",
      ).length;

    await admin
      .from("phdu_documentos_firma")
      .update({
        estado:
          yaFirmadas > 0
            ? "FIRMA_PARCIAL"
            : "PENDIENTE_FIRMA",
        hash_actual_sha256:
          pdfHash,
        actualizado_en:
          new Date().toISOString(),
      })
      .eq("id", doc.id);

    await admin
      .from("phdu_firma_eventos")
      .insert({
        documento_firma_id: doc.id,
        firma_id: firma.id,
        actor_id: user.id,
        evento: "FIRMAEC_SOLICITADA",
        detalle: {
          version: doc.version,
          nombreDocumento,
          orden: firma.orden,
          pdf_entrada_path: pdfPath,
          hash_entrada_sha256:
            pdfHash,
        },
      });

    const params =
      new URLSearchParams();

    params.set("token", token);

    if (firma.pagina) {
      params.set(
        "pagina",
        String(firma.pagina),
      );
    }

    if (firma.llx != null) {
      params.set(
        "llx",
        String(firma.llx),
      );
    }

    if (firma.lly != null) {
      params.set(
        "lly",
        String(firma.lly),
      );
    }

    if (firma.urx != null) {
      params.set(
        "urx",
        String(firma.urx),
      );
    }

    if (firma.ury != null) {
      params.set(
        "ury",
        String(firma.ury),
      );
    }

    if (firma.estampado) {
      params.set(
        "estampado",
        firma.estampado,
      );
    }

    if (firma.razon) {
      params.set(
        "razon",
        firma.razon,
      );
    }

    if (pre) {
      params.set("pre", "true");
    }

    const firmaecUrl =
      `firmaec://${encodeURIComponent(sistema)}/firmar?${params.toString()}`;

    return json({
      ok: true,
      firmaec_url: firmaecUrl,
      firma_id: firma.id,
      documento_firma_id: doc.id,
      numero_documento:
        doc.numero_documento,
      version: doc.version,
      nombre_documento:
        nombreDocumento,
      orden: firma.orden,
    });
  } catch (e) {
    return json(
      {
        error:
          e?.message ?? String(e),
      },
      500,
    );
  }
});
