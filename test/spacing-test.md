# Markdown 测试文档（CJK与西文混排版）

本文档在原有测试内容基础上，加入文言文与英语段落，用于观察不同语言、不同字符体系在段落间距、行距与整体观感上的表现。以下内容均为测试用文本。

段落间距是排版中容易被忽视却影响阅读体验的关键因素。间距过小，文字会显得拥挤，读者在长时间阅读时容易疲劳；间距过大，段落之间的逻辑联系又会被削弱，阅读节奏变得松散。理想的段落间距应当让每一段既独立成块，又与上下文保持自然的衔接。在中文排版中，通常建议段间距略大于行距，以形成清晰的视觉分组，同时避免页面显得过于碎片化。

## 文言文段落测试

古人云：“学不可以已。”青，取之于蓝，而青于蓝；冰，水为之，而寒于水。木直中绳，輮以为轮，其曲中规，虽有槁暴，不复挺者，輮使之然也。故木受绳则直，金就砺则利，君子博学而日参省乎己，则知明而行无过矣。此段取《劝学》之意，用于观察文言文短句较多、标点较密时的段落观感。

夫天地者，万物之逆旅也；光阴者，百代之过客也。而浮生若梦，为欢几何？古人秉烛夜游，良有以也。况阳春召我以烟景，大块假我以文章。会桃花之芳园，序天伦之乐事。群季俊秀，皆为惠连；吾人咏歌，独惭康乐。幽赏未已，高谈转清。开琼筵以坐花，飞羽觞而醉月。不有佳咏，何伸雅怀？此段句式长短交错，用于观察文言文在段落中的节奏与留白。

再补一段文言，以观连续多段之效。山不在高，有仙则名；水不在深，有龙则灵。斯是陋室，惟吾德馨。苔痕上阶绿，草色入帘青。谈笑有鸿儒，往来无白丁。可以调素琴，阅金经。无丝竹之乱耳，无案牍之劳形。南阳诸葛庐，西蜀子云亭。孔子云：何陋之有？文言段落往往句读频繁，段间距若处理得当，可使短句群仍保持整体的块状感。

## English Paragraph Test

The paragraph spacing of a document plays a subtle but important role in reading comfort. When spacing is too tight, text appears crowded and readers tire quickly during long reading sessions. When spacing is too generous, the logical connection between paragraphs weakens and the reading rhythm becomes loose. Ideally, paragraph spacing should allow each block to stand on its own while remaining naturally connected to its surroundings.

This paragraph continues the English test to observe how consecutive Latin-script paragraphs appear together. Unlike Chinese text, English paragraphs rely on word spacing and capitalization to signal structure, and the visual weight of a paragraph is distributed more evenly across the line. As a result, the same paragraph spacing value may feel different in English than in Chinese, and mixed-language documents require particular attention to consistency.

Here is one more English paragraph before moving on. Good typography is invisible when it works and obvious when it fails. Readers rarely notice well-balanced margins or carefully tuned line heights, but they immediately feel discomfort when something is off. The goal of this test document is therefore not to prescribe a specific value, but to help you judge whether the spacing in your rendering environment feels right across different languages and text densities.

### 三级标题：中英混排与列表

以下列表同时包含中文与英文条目，用于观察双语列表项之间的间距与对齐。

- 第一条：测试中文列表项的行距与段间距表现。
- Second item: testing how an English list item aligns with Chinese items above and below.
- 第三条：较长的列表项文字用于观察换行后第二行的缩进对齐情况，确保多行内容仍然保持清晰的层级关系。
- Fourth item: a longer English entry used to observe line wrapping and indentation when the content spans multiple lines within a single list item.

列表结束后的这一段，用于观察列表与正文之间的间距。若列表下方紧贴正文而没有足够留白，读者可能会误以为正文仍属于列表的一部分；反之，若间距过大，列表与后续解释之间的关联又会被切断。

> 这是一段引用文字，用于测试引用块的左右缩进、背景或边框样式，以及它与上下段落之间的间距。引用块通常需要在视觉上与正文形成明显区分，但又不应过于抢眼。
>
> This is a second paragraph inside the same blockquote, written in English, to observe how mixed-language content behaves within a quoted block.

引用块之后的正文段落，用于观察引用结束后的间距恢复情况。读者从引用块回到正文时，视线需要重新适应正常的行宽和缩进，因此引用块下方的留白应当足够，避免两种文本块在视觉上粘连。

## 代码块与表格的间距测试

代码块通常具有独立的背景色和等宽字体，其与周围段落的间距处理直接影响文档的专业感。以下代码块仅用于排版测试。

```java
public class SpacingTest {
    public static void main(String[] args) {
        System.out.println("This is a spacing test.");
    }
}
```

代码块上方的段落与代码块之间应保持清晰的距离，代码块下方同样需要留白，以免后续正文被误认为代码的一部分。下表同时包含中文与英文说明，用于测试表格与前后内容的间距以及单元格内的文字密度。

| 测试项 | Description | 观察重点 |
| --- | --- | --- |
| 段间距 | Distance between consecutive paragraphs | 是否均匀、舒适 |
| 标题间距 | Spacing around headings | 层级是否清晰 |
| 列表间距 | Spacing within and around lists | 分组是否明确 |
| 引用间距 | Spacing around blockquotes | 区隔是否自然 |

表格之后的结尾段落，用于确认表格下方留白是否充分。整篇文档到此结束，希望上述内容能够帮助你在实际渲染环境中判断段落间距的观感是否符合预期，尤其是在文言文与英语混排的情况下。