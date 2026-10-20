'use strict'; /*jslint node:true es9:true*/
// Business Search: Bright Data's ranked company and people search
// (POST /search/company, /search/people). One tool call = one billed search
// on HTTP 200, zero matches included; a 400 is free. No paging loop here:
// the result carries next_offset for the caller to ask again.
import {z} from 'zod';
import axios from 'axios';

const API = 'https://api.brightdata.com';
const MAX_OUTPUT_CHARS = parseInt(process.env.MAX_OUTPUT_CHARS||'200000', 10);
const MAX_DEPTH = 5;

const COMPANY = {
    source: 'linkedin_company',
    text: ['industry', 'name', 'about', 'slogan', 'specialties',
        'headquarters_location', 'investor_names'],
    equals: ['headquarters_country_code', 'headquarters_city',
        'organization_type', 'founded_year', 'funding_stage'],
    in: ['headquarters_country_code', 'offices_country_codes',
        'offices_cities', 'funding_stage'],
    range: ['founded_year', 'employees_in_linkedin', 'company_size_from',
        'company_size_to', 'funding_raised', 'linkedin_followers'],
    fields: ['company_id', 'linkedin_id', 'name', 'slogan', 'industry',
        'headquarters_location', 'headquarters_country_code',
        'offices_cities', 'company_size_from', 'company_size_to',
        'employees_in_linkedin', 'linkedin_followers', 'website', 'domain',
        'url', 'logo', 'about', 'specialties', 'organization_type',
        'founded_year', 'headquarters_city', 'offices_country_codes',
        'alumni_count', 'linkedin_follower_to_employee_ratio',
        'funding_stage', 'funding_raised', 'investor_names',
        'similar_company_ids', 'affiliated_company_ids', 'crunchbase_id',
        'image'],
};

const PEOPLE = {
    source: 'linkedin_people',
    text: ['current_title', 'all_text', 'name', 'about', 'location',
        'current_company_name', 'current_company_industry',
        'past_job_titles', 'past_company_names', 'certification_names',
        'role', 'company', 'skill'],
    equals: ['city', 'country_code'],
    in: ['city', 'country_code'],
    range: ['followers'],
    fields: ['linkedin_num_id', 'linkedin_person_id', 'name',
        'current_title', 'current_company_name', 'current_company_industry',
        'location', 'city', 'country_code', 'followers', 'connections', 'url',
        'avatar', 'first_name', 'about', 'recommendations_count',
        'influencer', 'patent_count', 'current_tenure_months',
        'experience_years', 'past_job_titles', 'past_company_names',
        'past_company_ids', 'education_schools', 'education_details',
        'certification_names', 'languages', 'current_company_id',
        'current_company_specialties', 'current_company_country_code',
        'current_company_size_from', 'current_company_size_to',
        'current_company_funding_stage', 'current_company_funding_raised',
        'similar_profile_ids', 'also_viewed_ids'],
};

const scalar = z.union([z.string().min(1), z.number(), z.boolean()]);
const text_value = z.union([
    z.string().min(1),
    z.object({
        value: z.string().min(1),
        mode: z.enum(['top-bm25', 'all', 'any']).optional()
            .describe('all = every word (stemmed, any order); any = one '
                +'word; top-bm25 (default) = ranked'),
        'top-k': z.number().int().positive().optional(),
    }).strict(),
]);
const bounds = z.object({
    '>': z.number().optional(), '>=': z.number().optional(),
    '<': z.number().optional(), '<=': z.number().optional(),
}).strict();

const shape_of = (names, schema)=>Object.fromEntries(
    names.map(n=>[n, schema.optional()]));

// One leaf = one operator holding exactly one field (checked in execute;
// a refine here would muddy the JSON schema clients see).
function leaf_schemas(e){
    return [
        z.object({text: z.object(shape_of(e.text, text_value)).strict()})
            .strict(),
        z.object({equals: z.object(shape_of(e.equals, scalar)).strict()})
            .strict(),
        z.object({in: z.object(shape_of(e.in, z.array(scalar).min(1)))
            .strict()}).strict(),
        z.object({range: z.object(shape_of(e.range, bounds)).strict()})
            .strict(),
    ];
}

function node_schema(e, depth, leaves=leaf_schemas(e)){
    if (depth<=1)
        return z.union(leaves);
    const child = node_schema(e, depth-1, leaves);
    return z.union([
        ...leaves,
        z.object({and: z.array(child).min(1)}).strict(),
        z.object({or: z.array(child).min(1)}).strict(),
        z.object({not: child}).strict(),
    ]);
}

function check_leaves(node, path='query'){
    const [op, payload] = Object.entries(node)[0];
    if (op=='and' || op=='or')
        return payload.forEach((c, i)=>check_leaves(c, `${path}.${op}[${i}]`));
    if (op=='not')
        return check_leaves(payload, `${path}.not`);
    const keys = Object.keys(payload);
    if (keys.length!=1)
        throw new Error(`${path}.${op} must name exactly one field `
            +`(got ${keys.length})`);
    if (op=='range' && !Object.keys(payload[keys[0]]).length)
        throw new Error(`${path}.range.${keys[0]} needs a bound`);
}

// Bright Data rejects instant/smart windows past 100 with a 500, so check
// the mode rules here and answer in plain words for free.
function check_request({mode, query, offset, limit}){
    if (mode=='ludicrous')
    {
        if (typeof query=='string')
            throw new Error('ludicrous needs a structured query (and/or/not, '
                +'text, equals, in, range), not a sentence');
        check_leaves(query);
        if (offset>1000)
            throw new Error('ludicrous offset max is 1000');
        return;
    }
    if (typeof query!='string')
        throw new Error(`${mode} needs a plain-English query (max 200 `
            +'chars); use ludicrous for a structured query');
    if (mode=='smart' && limit>10)
        throw new Error('smart limit max is 10');
    if (offset+limit>100)
        throw new Error(`${mode} only reaches the first 100 matches `
            +'(offset+limit <= 100); use ludicrous for more');
}

// Drop whole records from the end rather than cut JSON mid-record.
function fit(result){
    let text = JSON.stringify(result);
    const docs = result.documents||[];
    let kept = docs.length;
    while (text.length>MAX_OUTPUT_CHARS && kept>0)
    {
        kept = Math.max(0, Math.floor(kept*MAX_OUTPUT_CHARS/text.length)-1);
        text = JSON.stringify({...result, documents: docs.slice(0, kept),
            dropped: docs.length-kept,
            note: `Output cap: ${docs.length-kept} records dropped. Ask `
                +`again with offset ${result.meta.offset+kept} or a `
                +'narrower view.'});
    }
    return text;
}

function search_tool(entity, e, {name, description, hints}){
    return {
        name,
        description,
        annotations: {title: name.replace('_', ' '), readOnlyHint: true,
            openWorldHint: true},
        parameters: z.object({
            mode: z.enum(['ludicrous', 'instant', 'smart']).optional()
                .default('ludicrous').describe('ludicrous = structured '
                    +'query, up to 1,100 results by paging; instant = '
                    +'English sentence, first 100 only; smart = sentence, '
                    +'best-first, 10 per call, $3 not $2 per 1,000'),
            query: z.union([z.string().min(1).max(200),
                node_schema(e, MAX_DEPTH)]).describe('Sentence for '
                    +'instant/smart; for ludicrous a tree of {and|or:[...]}, '
                    +'{not:...} and leaves {text|equals|in|range:{field: '
                    +'value}}, one field per leaf. '+hints),
            limit: z.number().int().min(1).max(100).optional().default(25)
                .describe('Results per call (smart max 10). Billed per '
                    +'100-result block, so a smaller limit is not cheaper'),
            offset: z.number().int().min(0).max(1000).optional().default(0)
                .describe('Paging: previous offset + limit (next_offset)'),
            view: z.union([z.enum(['summary', 'full', 'id_only']),
                z.object({fields: z.array(z.enum(e.fields)).min(1)})
                    .strict()]).optional().default('summary')
                .describe('Fields returned (never filters): summary, full, '
                    +'id_only or {fields:[...]}. Absent values are left out'),
        }).strict(),
        execute: async({mode, query, limit, offset, view}, ctx, api_headers)=>{
            check_request({mode, query, offset, limit});
            const res = await axios({
                url: `${API}/search/${entity}`,
                method: 'POST',
                data: {source: e.source, mode, query, offset, limit, view},
                headers: {...api_headers(ctx.clientName, name),
                    'Content-Type': 'application/json'},
                validateStatus: ()=>true,
            });
            const body = res.data||{};
            if (res.status!=200)
            {
                const out = {status: res.status, error_code: body.error_code,
                    error: body.error||body.message||body, req_id: body.req_id};
                if (res.status==429)
                    out.retry_after = res.headers['retry-after'];
                throw new Error(`Business Search ${res.status} (not billed): `
                    +JSON.stringify(out));
            }
            const docs = body.documents||[];
            const result = {req_id: body.req_id, meta: body.meta,
                returned: docs.length};
            if (docs.length==limit)
                result.next_offset = offset+limit;
            result.documents = docs;
            return fit(result);
        },
    };
}

const COMPANY_HINTS = 'Text matching is stemmed words in any order, never '
    +'an exact phrase. headquarters_country_code is wrong both ways (foreign '
    +'HQs tagged US, US firms tagged foreign): match headquarters_location '
    +'text, state names spelled out or as codes. employees_in_linkedin is 0 '
    +'on about a quarter of records; a minimum of 1+ drops them. url is not '
    +'searchable. organization_type: Privately Held, Public Company, '
    +'Nonprofit, Educational, Self-Employed, Government Agency.';
const PEOPLE_HINTS = 'Text matching is stemmed words in any order, never an '
    +'exact phrase. current_company_name is a word match ("Acme" also hits '
    +'"Acme Robotics"): check names exactly afterwards. Titles catch noise '
    +'("president" hits "Vice President", "CEO" hits "Assistant to CEO"). '
    +'role = current+past titles+about; company = company text; skill = '
    +'about+certifications. Cannot filter on company size, funding or HQ: '
    +'search companies first.';

export function register_business_search({addTool, tool_fn, api_headers}){
    const tools = [
        search_tool('company', COMPANY, {
            name: 'search_companies',
            description: 'Find companies by criteria (industry, location, '
                +'size, founding year, funding) in Bright Data Business '
                +'Search over LinkedIn company records. Costs $0.002 per '
                +'call that returns 200, zero matches included.',
            hints: COMPANY_HINTS,
        }),
        search_tool('people', PEOPLE, {
            name: 'search_people',
            description: 'Find people by title, employer, past roles, skills '
                +'or location in Bright Data Business Search over LinkedIn '
                +'profiles. Costs $0.002 per call that returns 200, zero '
                +'matches included.',
            hints: PEOPLE_HINTS,
        }),
    ];
    for (const t of tools)
    {
        const execute = t.execute;
        addTool({...t, execute: tool_fn(t.name,
            (args, ctx)=>execute(args, ctx, api_headers))});
    }
}
