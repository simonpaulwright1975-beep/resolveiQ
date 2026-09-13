# Connecting to Sage CRM — reusable notes (any WG app)

Everything needed to connect a new app to the Geerings Sage CRM install, except
the credentials, which are deliberately not in this file.

Sources: the working Call iQ connection, Sage's own reference client
([Sage/sage_crm_rest_api_client](https://github.com/Sage/sage_crm_rest_api_client)),
and what ResolveIQ hit in practice.

---

## The constraint that decides your architecture

**Sage CRM is LAN-only.** It lives on `WG-SQL-01` and is not reachable from
outside the Geerings network.

Anything that touches it must run on WG-SQL-01, or another machine on that LAN —
as a scheduled task, service, or local server. A cloud-hosted app *cannot* reach
it, however it is configured. Decide this before you design anything else.

If your app also needs the internet (an AI API, Supabase), the box it runs on
needs both: the CRM on one side, outbound HTTPS on the other. Worth confirming —
the Call iQ worker only needs the CRM, so outbound may be untested ground.

---

## Two endpoints, two protocols

| | Read | Write |
|---|---|---|
| Protocol | SData (REST-ish) | SOAP |
| URL | `http://WG-SQL-01/sdata/crmj/sagecrm/-/<entity>` | `http://WG-SQL-01/CRM/eware.dll/webservice` |
| Auth | HTTP Basic | logon, then carry the session in a `<SessionHeader>` |
| Format | **Atom XML only** | SOAP envelopes |
| Operations | GET | add / update / query / delete |

**SData is read-only.** There is no write path over it — creating or updating a
record means SOAP.

### Read (SData)

```
GET http://WG-SQL-01/sdata/crmj/sagecrm/-/case
Authorization: Basic base64(user:password)
Accept: application/atom+xml
```

- **It returns XML and only XML.** Asking for `application/json` gets an error,
  not JSON. This is the single most likely thing to break a new integration —
  ResolveIQ was written against JSON first and would have failed on first
  contact.
- URL shape is `{server}/sdata/{install}j/{contract}/-/{entity}`. Here the
  install is `crm` (so `crmj`) and the contract is **`sagecrm`** — *not*
  `sagecrm2`, which is what Sage's own sample code uses. Other installs differ;
  make it configurable.
- Collections return an Atom feed: `<feed>` → `<entry>` → `<payload>` → one
  element named after the entity, with `sdata:key` on it and fields as children.
  Counts come back as `opensearch:totalResults` / `startIndex` / `itemsPerPage`.
- A single record is `{base}{entity}('{id}')`.
- `{base}$prototypes` lists every entity exposed to web services;
  `{base}$prototypes/{entity}` lists that entity's fields. Useful for checking a
  connection and for discovering custom entities.
- Paging and filtering: `count`, `startIndex`, `where`, `orderBy` as query
  parameters. `where` uses the CRM's own column names.

### Write (SOAP)

Logon, then carry the returned session in a `<SessionHeader>` on every
subsequent call. Entities confirmed working: `company`, `person`,
`communication`, `comm_link`, `users`.

Working implementation, with the gotchas already solved:

- On the server: `C:\WGCalls\sage-crm-worker\Push-CalliQToSageCRM.ps1`
- In the repo: `wg-calls/onprem/sage-crm-worker/` — the script plus a README
  with a full API cheat-sheet

**Do not write directly to the Sage CRM database**, even though it is on the
same box. It bypasses the application's integrity rules. Writes go through SOAP.

---

## Credentials

A Sage CRM user with **Allow Webservices = True** on their profile. Without that
flag the connection returns 401 no matter how correct everything else is.

Stored in:

- `C:\simon\sage-crm.env` (Simon's PC)
- `C:\WGCalls\sage-crm-worker\wg-calls-worker.env` (WG-SQL-01)

Read them from an env file per machine. Don't commit them, don't put them in a
repo, and don't paste them into a chat — including to me. I have never had them
and don't need them: everything in this document is shape, not secrets.

---

## Gotchas that cost time

These are the ones already paid for. Inherit them rather than rediscovering them.

- **XML, not JSON.** Covered above, and worth repeating because it fails
  immediately and confusingly.
- **Field-prefix stripping.** Columns come back prefixed (`case_description`,
  `comp_name`), but not consistently across installs and versions. Resolve
  fields by trying several candidate names, case-insensitively, with and without
  the prefix — don't hard-code one spelling.
- **`users` is plural.** The entity is `users`, not `user`, unlike the others.
- **`comm_link` does the linking.** A communication is attached to a company or
  person through `comm_link`, not by a field on the communication itself.
- **Delete is buggy.** Avoid it. Update a status instead where you can.
- **Namespace prefixes are not fixed.** Servers may use `sdata:`, `crm:` or
  anything else. Match on local element names, never on the prefix.
- **Custom fields exist.** Any install can rename columns or add its own, so
  treat the field list as something to discover, not assume.

---

## Code you can lift

From this repo (`simonpaulwright1975-beep/resolveiQ`), branch
`claude/kind-einstein-epz1qt`:

| File | What it gives you | Portable? |
|---|---|---|
| `server/sdata-xml.mjs` | Flattens an SData Atom feed into plain objects (`$key`, fields, nested linked entities). Matches on local element names. | **Yes** — only depends on `fast-xml-parser` |
| `server/sage.mjs` | Basic-auth client, XML/JSON content negotiation, collection/record/metadata calls, and `pick()` for tolerant field resolution | Mostly — imports `./config.mjs`, easy to swap |
| `scripts/check-sage.mjs` | Connection diagnostic: reachability, exposed entities, field names per entity, and whether a mapping resolves | Needs the two above |

All Node, no framework. `npm run check-sage` is the fastest way to prove a new
connection works — run it on WG-SQL-01 and it prints **field names and counts
only, never field values**, so the output is safe to share.

---

## Not yet verified

Two things ResolveIQ could not confirm without being on the LAN:

1. **Whether the `case` entity is exposed to web services.** Call iQ uses
   company / person / communication / comm_link / users. If your app needs
   cases, check first — `check-sage` reports it.
2. **Which field carries the Sage 200 account reference.** Sage CRM cases link
   to a *CRM company*, which is a different identifier from the Sage 200
   `account_ref` that the central customer record joins on. ResolveIQ tries
   several candidate names (`comp_accountid`, `account_ref`, `comp_code`,
   `comp_accountnumber`) and accepts null. **If this doesn't resolve, records
   save but never attach to a customer** — so confirm it before relying on any
   integration that writes to the shared record.

---

## Quick start for a new app

1. Decide where it runs. It has to be on the LAN.
2. Copy `server/sdata-xml.mjs` and the client from `server/sage.mjs`.
3. Point it at `http://WG-SQL-01/sdata/crmj/sagecrm/-/`, Basic auth, `Accept:
   application/atom+xml`.
4. Read credentials from an env file on that machine.
5. Run the equivalent of `check-sage` before building anything on top — it tells
   you which entities are readable and what the fields are really called.
6. For writes, lift the SOAP helpers from the Call iQ worker rather than writing
   them again.
