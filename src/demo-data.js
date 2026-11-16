// 演示用来源资料：一份带有序步骤、警告块、强调、链接和一处嵌套列表的安装说明。
// 最后一个列表含嵌套结构，门户可见工具栏无法表达，必须留给人处理。

export const demoDocument = {
  title: '低压配电柜安装说明',
  documentId: 'SYN-INSTALL-001',
  blocks: [
    {
      type: 'paragraph',
      runs: [{ text: '安装前请断电，并确认现场由两人作业。' }]
    },
    {
      type: 'paragraph',
      runs: [
        { text: '开始前阅读 ' },
        { text: '安全须知', bold: true },
        { text: ' 与 ' },
        { text: '接线图', link: 'https://example.test/manual/wiring' },
        { text: '。' }
      ]
    },
    {
      type: 'orderedList',
      items: [
        { runs: [{ text: '拆开包装，核对 ' }, { text: '铭牌参数', bold: true }, { text: ' 与到货清单。' }] },
        { runs: [{ text: '按 ' }, { text: '接线图', link: 'https://example.test/manual/wiring' }, { text: ' 连接保护地线。' }] },
        { runs: [{ text: '上电前测量绝缘电阻，读数记入验收单。' }] }
      ]
    },
    {
      type: 'warning',
      runs: [{ text: '警告：', bold: true }, { text: '未连接保护地线严禁上电。' }]
    },
    {
      type: 'orderedList',
      items: [
        { runs: [{ text: '用膨胀螺栓固定柜体。' }] },
        {
          runs: [{ text: '安装防护罩。' }],
          children: [
            {
              type: 'unorderedList',
              items: [
                { runs: [{ text: '先装内侧两颗螺栓。' }] },
                { runs: [{ text: '再装外侧两颗螺栓。' }] }
              ]
            }
          ]
        }
      ]
    },
    {
      type: 'paragraph',
      runs: [{ text: '完成后由质检人员签字确认。' }]
    }
  ]
};

export const demoStartHtml = '<p><br></p>';
