// ============================================================
// ALLPA · FirmaEC · retorno PDF firmado · V8.4.1
// Compatible con versiones documentales.
//
// IMPORTANTE:
// desplegar con verify_jwt = false.
//
// Secret requerido:
// FIRMAEC_CALLBACK_API_KEY
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

async function sha256Hex(
  bytes: Uint8Array,
) {
  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      bytes,
    );

  return [...new Uint8Array(hash)]
    .map((b) =>
      b.toString(16).padStart(2, "0")
    )
    .join("");
}

function text(
  value: string,
  status = 200,
) {
  return new Response(
    value,
    {
      status,
      headers: {
        "Content-Type":
          "text/plain; charset=utf-8",
      },
    },
  );
}

function decodeBase64(
  input: string,
) {
  const clean =
    input
      .replace(
        /^data:application\/pdf;base64,/i,
        "",
      )
      .trim();

  const binary =
    atob(clean);

  return Uint8Array.from(
    binary,
    (c) => c.charCodeAt(0),
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return text("0", 405);
  }

  try {
    const expectedKey =
      Deno.env.get(
        "FIRMAEC_CALLBACK_API_KEY",
      ) ?? "";

    const receivedKey =
      req.headers.get(
        "X-API-KEY",
      ) ?? "";

    if (
      !expectedKey ||
      receivedKey !== expectedKey
    ) {
      return text("0", 403);
    }

    const body =
      await req.json();

    const nombreDocumento =
      String(
        body?.nombreDocumento ?? "",
      ).trim();

    const cedula =
      String(
        body?.cedula ?? "",
      ).trim();

    const archivo =
      String(
        body?.archivo ?? "",
      ).trim();

    if (
      !nombreDocumento ||
      !cedula ||
      !archivo
    ) {
      return text("0", 400);
    }

    const supabaseUrl =
      Deno.env.get(
        "SUPABASE_URL",
      )!;

    const serviceKey =
      Deno.env.get(
        "SUPABASE_SERVICE_ROLE_KEY",
      )!;

    const admin =
      createClient(
        supabaseUrl,
        serviceKey,
      );

    // Buscar el turno exacto por nombre único.
    const {
      data: firma,
      error: firmaError,
    } = await admin
      .from("phdu_firmas_documento")
      .select("*")
      .eq(
        "firmaec_nombre_documento",
        nombreDocumento,
      )
      .limit(1)
      .maybeSingle();

    if (
      firmaError ||
      !firma
    ) {
      return text("0", 404);
    }

    // Callback duplicado: ya fue registrado correctamente.
    if (
      firma.estado === "FIRMADA" &&
      firma.archivo_path
    ) {
      return text("OK", 200);
    }

    if (
      firma.estado !== "EN_FIRMAEC"
    ) {
      return text("0", 409);
    }

    const {
      data: doc,
      error: docError,
    } = await admin
      .from("phdu_documentos_firma")
      .select("*")
      .eq(
        "id",
        firma.documento_firma_id,
      )
      .single();

    if (
      docError ||
      !doc
    ) {
      return text("0", 404);
    }

    if (
      ["FIRMADO","SUSTITUIDO","ANULADO"]
        .includes(doc.estado)
    ) {
      return text("0", 409);
    }

    const {
      data: identidad,
    } = await admin
      .from("phdu_firma_identidades")
      .select(
        "cedula,habilitado",
      )
      .eq(
        "user_id",
        firma.firmante_id,
      )
      .single();

    if (
      !identidad?.habilitado ||
      identidad.cedula !== cedula
    ) {
      await admin
        .from(
          "phdu_firmas_documento",
        )
        .update({
          estado: "ERROR",
          error:
            "La cédula devuelta por FirmaEC no corresponde al firmante esperado.",
          actualizado_en:
            new Date().toISOString(),
        })
        .eq("id", firma.id);

      return text("0", 409);
    }

    const firmasValidas =
      body?.firmasValidas === true;

    const integridad =
      body?.integridadDocumento === true;

    const errorFirma =
      String(
        body?.error ?? "",
      ).trim();

    const certificados =
      Array.isArray(
        body?.certificado,
      )
        ? body.certificado
        : [];

    const certFirmante =
      certificados.find(
        (c: any) =>
          String(
            c?.cedula ?? "",
          ).trim() === cedula,
      );

    const certificadoValido =
      certFirmante &&
      certFirmante.integridadFirma !== false &&
      certFirmante.certificadoDigitalValido !== false &&
      certFirmante.certificadoVigente !== false;

    if (
      !firmasValidas ||
      !integridad ||
      !certificadoValido ||
      (
        errorFirma &&
        errorFirma.toLowerCase() !== "null"
      )
    ) {
      await admin
        .from(
          "phdu_firmas_documento",
        )
        .update({
          estado: "ERROR",
          firmas_validas:
            firmasValidas,
          integridad_documento:
            integridad,
          certificado:
            certificados,
          error:
            errorFirma ||
            "FirmaEC devolvió una validación negativa.",
          actualizado_en:
            new Date().toISOString(),
        })
        .eq("id", firma.id);

      await admin
        .from(
          "phdu_documentos_firma",
        )
        .update({
          estado: "ERROR",
          actualizado_en:
            new Date().toISOString(),
        })
        .eq("id", doc.id);

      return text("0", 422);
    }

    const bytes =
      decodeBase64(archivo);

    const hash =
      await sha256Hex(bytes);

    // Cada versión tiene su propia carpeta.
    // No se usa upsert: un PDF firmado no se sobrescribe.
    const signedPath = [
      "firmados",
      doc.tipo_documento,
      doc.referencia_id,
      `v${doc.version}`,
      `firma_${firma.orden}_${firma.id}.pdf`,
    ].join("/");

    const upload =
      await admin.storage
        .from("allpa-firma")
        .upload(
          signedPath,
          bytes,
          {
            contentType:
              "application/pdf",
            upsert: false,
          },
        );

    if (upload.error) {
      return text("0", 500);
    }

    const fechaFirma =
      String(
        certFirmante?.fechaFirma ?? "",
      ).trim() ||
      new Date().toISOString();

    await admin
      .from(
        "phdu_firmas_documento",
      )
      .update({
        estado: "FIRMADA",
        fecha_firma:
          fechaFirma,
        archivo_path:
          signedPath,
        hash_archivo_sha256:
          hash,
        firmas_validas:
          true,
        integridad_documento:
          true,
        certificado:
          certificados,
        error: null,
        actualizado_en:
          new Date().toISOString(),
      })
      .eq("id", firma.id);

    // Esta salida pasa a ser la entrada de la siguiente firma.
    await admin
      .from(
        "phdu_documentos_firma",
      )
      .update({
        pdf_actual_path:
          signedPath,
        hash_actual_sha256:
          hash,
        actualizado_en:
          new Date().toISOString(),
      })
      .eq("id", doc.id);

    const {
      data: firmasVersion,
    } = await admin
      .from(
        "phdu_firmas_documento",
      )
      .select(
        "id,estado,orden",
      )
      .eq(
        "documento_firma_id",
        doc.id,
      )
      .order(
        "orden",
        { ascending: true },
      );

    const pendientes =
      (firmasVersion ?? [])
        .filter(
          (f) =>
            f.estado !== "FIRMADA",
        );

    const terminado =
      pendientes.length === 0;

    if (terminado) {
      // Esta RPC hace el cambio de vigencia de forma atómica:
      // V1 -> SUSTITUIDO, V2 -> FIRMADO/VIGENTE.
      const {
        error: confirmarError,
      } = await admin.rpc(
        "phdu_confirmar_version_firmada",
        {
          p_documento_firma_id:
            doc.id,
          p_pdf_actual_path:
            signedPath,
          p_hash_actual_sha256:
            hash,
          p_completado_en:
            new Date().toISOString(),
        },
      );

      if (confirmarError) {
        await admin
          .from(
            "phdu_firmas_documento",
          )
          .update({
            estado: "ERROR",
            error:
              `La firma fue recibida, pero no se pudo actualizar la vigencia: ${confirmarError.message}`,
            actualizado_en:
              new Date().toISOString(),
          })
          .eq("id", firma.id);

        return text("0", 500);
      }
    } else {
      await admin
        .from(
          "phdu_documentos_firma",
        )
        .update({
          estado:
            "FIRMA_PARCIAL",
          actualizado_en:
            new Date().toISOString(),
        })
        .eq("id", doc.id);
    }

    await admin
      .from(
        "phdu_firma_eventos",
      )
      .insert({
        documento_firma_id:
          doc.id,
        firma_id:
          firma.id,
        actor_id:
          firma.firmante_id,
        evento:
          "FIRMAEC_RECIBIDA",
        detalle: {
          version:
            doc.version,
          nombreDocumento,
          orden:
            firma.orden,
          firmasValidas,
          integridadDocumento:
            integridad,
          hash_sha256:
            hash,
          pdf_salida_path:
            signedPath,
          version_completamente_firmada:
            terminado,
        },
      });

    return text(
      "OK",
      200,
    );
  } catch (_e) {
    return text("0", 500);
  }
});
