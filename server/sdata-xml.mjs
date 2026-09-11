/* SData Atom → plain records.

   Sage CRM's SData endpoint returns Atom XML, not JSON (asking for JSON gets an
   error on the Geerings install). A feed looks roughly like:

     <feed xmlns="http://www.w3.org/2005/Atom"
           xmlns:sdata="http://schemas.sage.com/sdata/2008/1"
           xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
       <opensearch:totalResults>3</opensearch:totalResults>
       <opensearch:startIndex>1</opensearch:startIndex>
       <opensearch:itemsPerPage>10</opensearch:itemsPerPage>
       <entry>
         <title>Refund not received</title>
         <sdata:payload>
           <case sdata:key="41">
             <case_caseid>41</case_caseid>
             <case_description>Refund not received</case_description>
             <Company sdata:key="7"><comp_name>Blake Retail</comp_name></Company>
           </case>
         </sdata:payload>
       </entry>
     </feed>

   This module flattens that into the same object shape the JSON path produced
   ($key / $title / flat fields / nested linked entities), so mapCase() and its
   tests are unchanged by the transport swap.

   Namespace prefixes are not assumed — servers are free to choose them — so
   lookups are by local name. */

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  /* Keep prefixes off element names so we can match on local names. */
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: true,
  trimValues: true
});

/* An element's text may arrive as a string, a number, or an object with
   attributes and a #text child. Reduce all of those to a scalar. */
function scalar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') {
    if ('#text' in value) return value['#text'];
    /* An element with only a nil/null attribute carries no value. */
    return null;
  }
  return value;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/* True when a node looks like a linked entity rather than a plain field:
   it has child elements of its own, or an sdata key/uri attribute. */
function isLinkedEntity(node) {
  if (!node || typeof node !== 'object') return false;
  if ('@key' in node || '@uri' in node) return true;
  return Object.keys(node).some((k) => !k.startsWith('@') && k !== '#text');
}

/* Turn one payload element (the <case>…</case> inside <payload>) into a flat
   record, with nested linked entities kept as objects. */
export function payloadToRecord(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const record = {};

  const key = payload['@key'];
  if (key !== undefined) {
    const n = Number(key);
    record.$key = Number.isFinite(n) ? n : key;
  }
  if (payload['@uri'] !== undefined) record.$url = payload['@uri'];

  for (const [name, raw] of Object.entries(payload)) {
    if (name.startsWith('@') || name === '#text') continue;

    /* Repeated elements: take the first — the console shows one value. */
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (isLinkedEntity(value)) {
      const nested = payloadToRecord(value);
      /* Give the linked entity a title so pick() can find a display name. */
      if (!nested.$title) {
        nested.$title =
          scalar(value.comp_name) ??
          scalar(value.pers_fullname) ??
          scalar(value.name) ??
          null;
      }
      record[name] = nested;
    } else {
      record[name] = scalar(value);
    }
  }

  return record;
}

/* Parse a collection feed. Returns the same shape the JSON branch returned. */
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const feed = doc.feed ?? doc.Feed;

  if (!feed) {
    /* A single record request returns <entry> at the root, not a feed. */
    const entry = doc.entry ?? doc.Entry;
    if (entry) {
      const records = entriesToRecords(entry);
      return { total: records.length, startIndex: 1, perPage: records.length, records };
    }
    return { total: 0, startIndex: 1, perPage: 0, records: [] };
  }

  const records = entriesToRecords(feed.entry);

  return {
    total: Number(scalar(feed.totalResults) ?? records.length) || records.length,
    startIndex: Number(scalar(feed.startIndex) ?? 1) || 1,
    perPage: Number(scalar(feed.itemsPerPage) ?? records.length) || records.length,
    records
  };
}

function entriesToRecords(entry) {
  return asArray(entry).map((e) => {
    const payloadWrapper = e.payload ?? e.Payload;
    /* <payload> holds exactly one child element named after the entity. */
    let payload = null;
    if (payloadWrapper && typeof payloadWrapper === 'object') {
      const childKey = Object.keys(payloadWrapper).find(
        (k) => !k.startsWith('@') && k !== '#text'
      );
      if (childKey) {
        const child = payloadWrapper[childKey];
        payload = Array.isArray(child) ? child[0] : child;
      }
    }

    const record = payloadToRecord(payload);

    /* The Atom <title> is a useful fallback display name. */
    const title = scalar(e.title);
    if (title && !record.$title) record.$title = title;

    return record;
  });
}

/* Single-record responses: return the one record, or null. */
export function parseEntry(xml) {
  const { records } = parseFeed(xml);
  return records[0] ?? null;
}
