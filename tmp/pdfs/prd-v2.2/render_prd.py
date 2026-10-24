from pathlib import Path
from xml.sax.saxutils import escape
import re

from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether

ROOT = Path('/Users/lucifer/Desktop/gpt-workspace/openGym')
SOURCE = ROOT / 'output/pdf/openGym-社区活力三件套-PRD-v2.2.md'
OUTPUT = SOURCE.with_suffix('.pdf')
pdfmetrics.registerFont(TTFont('CJK', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))

INK = colors.HexColor('#152b31')
TEAL = colors.HexColor('#087f80')
GRAY = colors.HexColor('#56666a')
PALE = colors.HexColor('#e8f3f1')

styles = {
 'h1': ParagraphStyle('h1', fontName='CJK', fontSize=21, leading=30, textColor=INK, spaceAfter=18, wordWrap='CJK', keepWithNext=True),
 'h2': ParagraphStyle('h2', fontName='CJK', fontSize=12, leading=19, textColor=TEAL, spaceBefore=11, spaceAfter=7, wordWrap='CJK', keepWithNext=True),
 'p': ParagraphStyle('p', fontName='CJK', fontSize=9.7, leading=16.6, textColor=INK, spaceAfter=7, wordWrap='CJK', splitLongWords=True),
 'bullet': ParagraphStyle('bullet', fontName='CJK', fontSize=9.7, leading=16.6, textColor=INK, leftIndent=11, firstLineIndent=-9, spaceAfter=5, wordWrap='CJK'),
 'cover': ParagraphStyle('cover', fontName='CJK', fontSize=29, leading=42, textColor=INK, spaceAfter=15, wordWrap='CJK', keepWithNext=True),
}

sections = SOURCE.read_text().split('<!-- page -->')
titles = [next((l[2:] for l in s.strip().splitlines() if l.startswith('# ')), '') for s in sections]

def frame(c, doc):
 c.saveState()
 w,h=doc.pagesize
 if doc.page == 1:
  c.setFillColor(TEAL); c.rect(0,h-158,w,158,fill=1,stroke=0)
  c.setFillColor(colors.white); c.setFont('Helvetica-Bold',13)
  c.drawString(46,h-59,'openGym / PRODUCT REQUIREMENTS')
  c.setFont('Helvetica',10); c.drawString(46,h-85,'VERSION 2.2     /     EXECUTION SPECIFICATION')
  c.setFillColor(colors.HexColor('#c9f0d0')); c.rect(46,h-118,42,4,fill=1,stroke=0)
 else:
  c.setFillColor(TEAL); c.rect(0,h-7,w,7,fill=1,stroke=0)
  c.setFont('Helvetica-Bold',8.5); c.setFillColor(TEAL)
  c.drawString(46,h-34,'openGym / PRD v2.2')
  c.setFont('CJK',8); c.setFillColor(GRAY)
  c.drawRightString(w-46,h-34,'执行细化稿 · 核心边界已确认')
  c.setStrokeColor(PALE); c.line(46,h-45,w-46,h-45)
 c.setStrokeColor(PALE); c.line(46,43,w-46,43)
 c.setFont('Helvetica',8); c.setFillColor(GRAY)
 c.drawString(46,28,'2026-10-24  /  openGym v1.4.1')
 c.drawRightString(w-46,28,f'{doc.page:02d} / {len(sections):02d}')
 c.restoreState()

class PRDDoc(SimpleDocTemplate):
 def afterFlowable(self, flowable):
  if isinstance(flowable, Paragraph) and flowable.style.name in ('h1','cover'):
   key = 'page-%d' % self.page
   self.canv.bookmarkPage(key)
   self.canv.addOutlineEntry(flowable.getPlainText(),key,0,False)

doc=PRDDoc(str(OUTPUT),pagesize=(595.276,841.89),rightMargin=46,leftMargin=46,topMargin=64,bottomMargin=61,
 title='openGym 社区活力三件套 PRD v2.2',author='openGym 产品与工程规划',subject='已确认边界、数据模型、接口、开发步骤及验收')
story=[]
for i,section in enumerate(sections):
 if i: story.append(PageBreak())
 else: story.append(Spacer(1,120))
 for line in section.strip().splitlines():
  line=line.strip()
  if not line: continue
  if line.startswith('# '): style='cover' if i==0 else 'h1'; content=line[2:]
  elif line.startswith('## '): style='h2'; content=line[3:]
  elif line.startswith('- '): style='bullet'; content='• '+line[2:]
  else: style='p';content=line
  content=escape(content)
  if line.startswith('https://'):
   content=f'<link href="{content}" color="#087f80">{content}</link>'
  story.append(Paragraph(content,styles[style]))
doc.build(story,onFirstPage=frame,onLaterPages=frame)
print(OUTPUT)
