# Generates a leadership-friendly ER diagram for the JBSTestOpsAI schema.
from PIL import Image, ImageDraw, ImageFont
import math

W, H = 2640, 1760
SCALE = 2  # supersample for crisp text
img = Image.new("RGB", (W*SCALE, H*SCALE), "white")
d = ImageDraw.Draw(img)

AR = "C:/Windows/Fonts/arial.ttf"
ARB = "C:/Windows/Fonts/arialbd.ttf"
def F(sz, bold=False):
    return ImageFont.truetype(ARB if bold else AR, sz*SCALE)

f_title = F(15, True)
f_field = F(12)
f_grp = F(17, True)
f_leg = F(13)
f_rel = F(11, True)
f_head = F(30, True)
f_sub = F(14)

# Group colors: (header fill, body fill, border)
GROUPS = {
    "A": ("#1F4E79", "#D6E4F0", "#1F4E79"),  # Identity / Tenancy
    "B": ("#7030A0", "#E7DAF2", "#7030A0"),  # Integrations
    "C": ("#C55A11", "#FBE2D5", "#C55A11"),  # Chat
    "D": ("#2E7D32", "#D9EFD9", "#2E7D32"),  # Test Authoring
    "E": ("#B8860B", "#FBF0D0", "#B8860B"),  # Pipeline Orchestration
    "F": ("#0E7490", "#D4EEF3", "#0E7490"),  # Test Data
    "G": ("#A6261D", "#F7DAD7", "#A6261D"),  # Audit
}

# table: (x, y, group, title, [fields])  -- x,y top-left in base coords
boxes = {}
def add(key, x, y, grp, title, fields):
    boxes[key] = dict(x=x, y=y, grp=grp, title=title, fields=fields)

ROW_H = 26
TITLE_H = 34
BW = 312

# Column 1 - Identity & Audit
add("tenants", 60, 150, "A", "tenants", ["PK id", "name, slug", "is_platform", "anthropic_api_key 🔒"])
add("users", 60, 430, "A", "users", ["PK id", "FK tenant_id", "username, role", "password_hash 🔒"])
add("audit_log", 60, 720, "G", "audit_log", ["PK id", "FK tenant_id", "action, resource", "request_id"])

# Column 2 - Integrations & Chat
add("client_configurations", 430, 150, "B", "client_configurations", ["PK id", "FK tenant_id", "integration_id", "config_data 🔒"])
add("conversations", 430, 440, "C", "conversations", ["PK id", "tenant_id", "username, title"])
add("messages", 430, 690, "C", "messages", ["PK id", "FK conversation_id", "role, content"])
add("jira_connections", 430, 940, "D", "jira_connections", ["PK id", "tenant_id", "jira_url", "auth_header 🔒"])

# Column 3 - Test Authoring (D)
add("test_runs", 800, 150, "D", "test_runs", ["PK id", "tenant_id", "story_key, module"])
add("test_cases", 800, 400, "D", "test_cases", ["PK id", "FK test_run_id", "title, steps", "priority, status"])
add("automation_scripts", 800, 690, "D", "automation_scripts", ["PK id", "test_run_id", "test_case_id", "code, framework"])

# Column 4 - Pipeline core (E)
add("qa_pipeline_runs", 1180, 150, "E", "qa_pipeline_runs", ["PK id", "FK tenant_id", "feature, module", "stage, status, cost"])
add("qa_stage_results", 1180, 470, "E", "qa_stage_results", ["PK id", "FK run_id", "stage_id, status", "agent_model"])
add("qa_worker_tasks", 1180, 720, "E", "qa_worker_tasks", ["PK id", "FK run_id", "agent_prompt", "status, result"])
add("qa_artifacts", 1180, 970, "E", "qa_artifacts", ["PK id", "FK run_id", "name, type", "content, version"])

# Column 5 - Pages & config (E)
add("qa_pages", 1560, 150, "E", "qa_pages", ["PK id", "tenant_id, module", "FK parent_page_id", "target_url"])
add("qa_page_stage_status", 1560, 430, "E", "qa_page_stage_status", ["PK id", "FK page_id", "FK active_run_id", "stage_id, status"])
add("qa_client_setup", 1560, 710, "E", "qa_client_setup", ["PK id", "tenant_id", "FK setup_run_id", "home_url, auth"])
add("qa_pipeline_definitions", 1560, 970, "E", "qa_pipeline_definitions", ["PK id", "tenant_id", "definition, version"])

# Column 6 - Test Data (F) + agent catalog
add("test_datasets", 1940, 150, "F", "test_datasets", ["PK id", "FK test_run_id", "role, scenario", "fields, layer"])
add("test_field_data", 1940, 430, "F", "test_field_data", ["PK id", "FK test_run_id", "field_name, value", "type, source"])
add("test_data_mapping", 1940, 710, "F", "test_data_mapping", ["PK id", "FK test_run_id", "test_case_id", "dataset_id"])
add("qa_agent_types", 1940, 970, "E", "qa_agent_types", ["PK id", "name, model", "agent_file", "enabled"])

def box_rect(b):
    h = TITLE_H + ROW_H*len(b["fields"])
    return b["x"], b["y"], b["x"]+BW, b["y"]+h

def rr(xy, r, **kw):
    d.rounded_rectangle([c*SCALE for c in xy], radius=r*SCALE, **kw)

# ---- draw relationships first (behind boxes) ----
def center(b):
    x0,y0,x1,y1 = box_rect(b)
    return ((x0+x1)/2, (y0+y1)/2)

def border_point(b, tx, ty):
    # point on box border along line from box center toward (tx,ty)
    x0,y0,x1,y1 = box_rect(b)
    cx,cy = (x0+x1)/2, (y0+y1)/2
    dx,dy = tx-cx, ty-cy
    if dx==0 and dy==0: return cx,cy
    sx = (x1-cx)/dx if dx>0 else ((x0-cx)/dx if dx<0 else math.inf)
    sy = (y1-cy)/dy if dy>0 else ((y0-cy)/dy if dy<0 else math.inf)
    s = min(abs(sx), abs(sy))
    return cx+dx*s, cy+dy*s

def crowfoot(px, py, ang):
    # draw a crow's foot (many) at point px,py, opening back along ang
    L = 16
    spread = 0.42
    for a in (ang-spread, ang, ang+spread):
        ex = px + L*math.cos(a); ey = py + L*math.sin(a)
        d.line([(px*SCALE,py*SCALE),(ex*SCALE,ey*SCALE)], fill="#5B6B7B", width=2*SCALE)

def relate(pkey, ckey, label=None):
    # one (parent pk) -> many (child fk)
    pb, cb = boxes[pkey], boxes[ckey]
    pc, cc = center(pb), center(cb)
    p1 = border_point(pb, *cc)
    p2 = border_point(cb, *pc)
    d.line([(p1[0]*SCALE,p1[1]*SCALE),(p2[0]*SCALE,p2[1]*SCALE)], fill="#5B6B7B", width=2*SCALE)
    # one-tick near parent
    ang = math.atan2(p2[1]-p1[1], p2[0]-p1[0])
    perp = ang+math.pi/2
    ox,oy = p1[0]+12*math.cos(ang), p1[1]+12*math.sin(ang)
    d.line([((ox+8*math.cos(perp))*SCALE,(oy+8*math.sin(perp))*SCALE),
            ((ox-8*math.cos(perp))*SCALE,(oy-8*math.sin(perp))*SCALE)], fill="#5B6B7B", width=2*SCALE)
    # crow's foot at child
    crowfoot(p2[0], p2[1], ang+math.pi)
    if label:
        mx,my = (p1[0]+p2[0])/2, (p1[1]+p2[1])/2
        tb = d.textbbox((0,0), label, font=f_rel)
        tw,th = tb[2]-tb[0], tb[3]-tb[1]
        d.rectangle([(mx*SCALE-tw/2-3*SCALE,my*SCALE-th/2-2*SCALE),(mx*SCALE+tw/2+3*SCALE,my*SCALE+th/2+2*SCALE)], fill="white")
        d.text((mx*SCALE-tw/2, my*SCALE-th/2-2*SCALE), label, font=f_rel, fill="#33414F")

rels = [
    ("tenants","users"), ("tenants","client_configurations"), ("tenants","audit_log"),
    ("tenants","qa_pipeline_runs"),
    ("conversations","messages"),
    ("test_runs","test_cases"), ("test_runs","automation_scripts"),
    ("qa_pipeline_runs","qa_stage_results"), ("qa_pipeline_runs","qa_worker_tasks"),
    ("qa_pipeline_runs","qa_artifacts"),
    ("qa_pages","qa_page_stage_status"), ("qa_pipeline_runs","qa_page_stage_status"),
    ("qa_pipeline_runs","qa_client_setup"),
    ("qa_pipeline_runs","test_datasets"), ("qa_pipeline_runs","test_field_data"),
    ("qa_pipeline_runs","test_data_mapping"),
]
for r in rels:
    relate(*r)

# self reference on qa_pages (parent_page_id)
qp = boxes["qa_pages"]; x0,y0,x1,y1 = box_rect(qp)
d.line([(x1*SCALE,(y0+18)*SCALE),((x1+26)*SCALE,(y0+18)*SCALE),
        ((x1+26)*SCALE,(y0+46)*SCALE),(x1*SCALE,(y0+46)*SCALE)], fill="#5B6B7B", width=2*SCALE)
crowfoot(x1, y0+46, math.pi)

# ---- draw boxes ----
for key,b in boxes.items():
    hdr, body, brd = GROUPS[b["grp"]]
    x0,y0,x1,y1 = box_rect(b)
    rr((x0,y0,x1,y1), 9, fill=body, outline=brd, width=2*SCALE)
    # header
    d.rounded_rectangle([x0*SCALE,y0*SCALE,x1*SCALE,(y0+TITLE_H)*SCALE], radius=9*SCALE, fill=hdr)
    d.rectangle([x0*SCALE,(y0+TITLE_H-10)*SCALE,x1*SCALE,(y0+TITLE_H)*SCALE], fill=hdr)
    d.text((x0*SCALE+12*SCALE, y0*SCALE+8*SCALE), b["title"], font=f_title, fill="white")
    for i,fld in enumerate(b["fields"]):
        fy = y0+TITLE_H+i*ROW_H+5
        col = "#222222"
        d.text((x0*SCALE+14*SCALE, fy*SCALE), fld, font=f_field, fill=col)

# ---- title ----
d.text((60*SCALE, 40*SCALE), "JBSTestOpsAI — Database Entity-Relationship Diagram", font=f_head, fill="#1F2D3A")
d.text((62*SCALE, 95*SCALE), "22 tables across 7 functional groups. Every business table is isolated per customer via tenant_id.  \U0001F512 = encrypted at rest.", font=f_sub, fill="#55636E")

# ---- legend ----
legend = [("A","Identity / Tenancy"),("B","Integrations"),("C","Chat"),("D","Test Authoring & Execution"),
          ("E","Pipeline Orchestration"),("F","Test Data"),("G","Audit")]
lx, ly = 60, H-95
d.text((lx*SCALE, (ly-30)*SCALE), "Legend", font=f_grp, fill="#1F2D3A")
cx = lx
for k,name in legend:
    hdr, body, brd = GROUPS[k]
    d.rounded_rectangle([cx*SCALE, ly*SCALE, (cx+26)*SCALE, (ly+26)*SCALE], radius=5*SCALE, fill=body, outline=brd, width=2*SCALE)
    d.text((cx*SCALE, (ly+30)*SCALE), name, font=f_leg, fill="#333333")
    tb = d.textbbox((0,0), name, font=f_leg)
    cx += max(34 + (tb[2]-tb[0])//SCALE + 26, 120)

# relationship key
ky = H-95
d.text((1980*SCALE, (ky-30)*SCALE), "Relationships", font=f_grp, fill="#1F2D3A")
d.line([(1980*SCALE, (ky+12)*SCALE),(2060*SCALE,(ky+12)*SCALE)], fill="#5B6B7B", width=2*SCALE)
crowfoot(2060, ky+12, math.pi)
d.text((2075*SCALE,(ky+4)*SCALE), "one  →  many (FK)", font=f_leg, fill="#333333")

img = img.resize((W, H), Image.LANCZOS)
img.save("C:/Dev/JBSIntelliQE/docs/assets/er-diagram.png")
print("saved", img.size)
