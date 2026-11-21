// JSON read inside Effect code: decoded through Schema, so text that is not what was expected is a value to handle,
// never a throw (the Effect language service's globalJsonInEffect).
import * as Schema from "effect/Schema";

/** A JSON text decoded as a JSON object, or none (not JSON, or JSON that is not an object). */
export const decodeJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)));
