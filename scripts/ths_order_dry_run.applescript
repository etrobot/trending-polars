-- 同花顺“模拟练习”辅助接口。
--
-- 只操作明确包含“模拟练习”的窗口；找不到、字段不一致或委托无法回查时立即失败。
--
-- 查询：
--   osascript scripts/ths_order_dry_run.applescript snapshot funds
--   osascript scripts/ths_order_dry_run.applescript snapshot positions
--   osascript scripts/ths_order_dry_run.applescript snapshot orders
--   osascript scripts/ths_order_dry_run.applescript snapshot account
--   osascript scripts/ths_order_dry_run.applescript snapshot account 600001,000815
--   osascript scripts/ths_order_dry_run.applescript quote 600519
--   osascript scripts/ths_order_dry_run.applescript cancel buy 600519 100
--
-- 下单（只会提交同花顺模拟委托）：
--   osascript scripts/ths_order_dry_run.applescript order buy 600519 AUTO 100
--   osascript scripts/ths_order_dry_run.applescript order sell 600519 AUTO 100
--
-- 兼容旧调用：
--   osascript scripts/ths_order_dry_run.applescript 600519 1327.50 100

property stoleFocus : false
property snapshotHintCodes : {}
property snapshotFundRowsFound : false
property snapshotFoundCodes : {}

on run argv
    if (count of argv) >= 2 then
        set commandName to item 1 of argv as text

        if commandName is "snapshot" then
            if (count of argv) < 2 or (count of argv) > 3 then error my usageText()
            set snapshotKind to item 2 of argv as text
            set hintCodes to {}
            if (count of argv) is 3 then set hintCodes to my parseHintCodes(item 3 of argv as text)
            if snapshotKind is "account_passive" then return my takeAccountSnapshot(hintCodes, true)
            return my takeSnapshot(snapshotKind, hintCodes)
        else if commandName is "quote" then
            if (count of argv) is not 2 then error my usageText()
            return my readSimulatedQuote(item 2 of argv as text)
        else if commandName is "order" then
            if (count of argv) is not 5 then error my usageText()
            return my submitSimulatedOrder(item 2 of argv as text, item 3 of argv as text, item 4 of argv as text, item 5 of argv as text)
        else if commandName is "verify" then
            if (count of argv) is not 5 then error my usageText()
            return my verifyOrder(item 2 of argv as text, item 3 of argv as text, item 4 of argv as text, item 5 of argv as text)
        else if commandName is "cancel" then
            if (count of argv) is not 4 then error my usageText()
            return my cancelSimulatedOrder(item 2 of argv as text, item 3 of argv as text, item 4 of argv as text)
        end if
    end if

    if (count of argv) is 3 then
        return my submitSimulatedOrder("buy", item 1 of argv, item 2 of argv, item 3 of argv)
    end if

    error my usageText()
end run

on usageText()
    return "用法：snapshot funds|positions|orders|account|account_passive [代码1,代码2]；quote 股票代码；order buy|sell 股票代码 价格|AUTO 数量；verify buy|sell 股票代码 价格|AUTO 数量；cancel buy|sell 股票代码 数量"
end usageText

on parseHintCodes(rawHints)
    set parsed to {}
    set normalized to my replaceText(rawHints as text, " ", "")
    if normalized is "" then return parsed
    set AppleScript's text item delimiters to ","
    set parts to text items of normalized
    set AppleScript's text item delimiters to ""
    repeat with i from 1 to count of parts
        set codeText to item i of parts as text
        if my isStockCode(codeText) then set end of parsed to codeText
    end repeat
    return parsed
end parseHintCodes

on cancelSimulatedOrder(orderSide, orderCode, orderQuantity)
    if orderSide is not in {"buy", "sell"} then error "撤单方向必须是 buy 或 sell"
    if not my isStockCode(orderCode) then error "股票代码必须是6位数字"
    if not my isPositiveInteger(orderQuantity) then error "撤单数量必须是正整数"
    set sideLabel to "买入"
    if orderSide is "sell" then set sideLabel to "卖出"
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到同花顺模拟交易窗口"
            if not my elementContainsText(simulationWindow, "模拟练习") then error "撤单前无法确认模拟交易状态"
            my refreshSimulationConnection(simulationWindow)
            my navigateTo(simulationWindow, "orders")
            delay 0.6

            set orderRow to my findOrderRow(simulationWindow, sideLabel, orderCode, orderQuantity)
            if orderRow is missing value then error "未找到匹配的可撤模拟委托：" & sideLabel & " " & orderCode & " " & orderQuantity
            set beforeText to my collectElementText(orderRow)
            if my isFinalOrderStatus(beforeText) then error "委托已是终态，不能撤单：" & beforeText

            try
                set selected of orderRow to true
            end try
            try
                my pressControl(orderRow)
            end try
            delay 0.2

            set cancelButton to my findNamedControl(simulationWindow, {"撤单", "撤销委托", "撤销"})
            if cancelButton is missing value then error "未识别到撤单按钮"
            if not (enabled of cancelButton) then error "撤单按钮不可用"
            my pressControl(cancelButton)

            set cancelSheet to my waitForSheet(simulationWindow, 15)
            if cancelSheet is not missing value then
                if not my elementContainsText(cancelSheet, "撤") then error "弹窗不是撤单确认，已停止"
                if my elementContainsText(cancelSheet, orderCode) is false then error "撤单确认中的股票代码不一致"
                set confirmButton to my findNamedControl(cancelSheet, {"确认", "确定", "撤单"})
                if confirmButton is missing value then error "未识别到撤单确认按钮"
                my pressControl(confirmButton)
            end if

            delay 0.8
            set resultText to ""
            try
                tell simulationWindow
                    if (count of sheets) > 0 then
                        set resultSheet to sheet 1
                        set resultText to my collectElementText(resultSheet)
                        set dismissButton to my findNamedControl(resultSheet, {"确定", "确认", "知道了"})
                        if dismissButton is not missing value then my pressControl(dismissButton)
                    end if
                end tell
            end try

            delay 0.5
            my navigateTo(simulationWindow, "orders")
            delay 0.5
            set verifiedRow to my findOrderRow(simulationWindow, sideLabel, orderCode, orderQuantity)
            set verifiedText to ""
            if verifiedRow is not missing value then set verifiedText to my collectElementText(verifiedRow)
            if (my isCancelledOrderStatus(verifiedText)) or (my isCancelledOrderStatus(resultText)) then
                my restoreForegroundApp(previousApp)
                return "CANCEL_VERIFIED|" & orderSide & "|" & orderCode & "|" & orderQuantity & linefeed & "STATUS|" & my sanitize(verifiedText & " " & resultText)
            end if
            my restoreForegroundApp(previousApp)
            error "撤单已操作，但委托列表未显示已撤状态：" & my sanitize(verifiedText & " " & resultText)
        end tell
    end tell
end cancelSimulatedOrder

on readSimulatedQuote(orderCode)
    if not my isStockCode(orderCode) then error "股票代码必须是6位数字"
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到同花顺模拟交易窗口"
            my refreshSimulationConnection(simulationWindow)
            my navigateTo(simulationWindow, "buy")
            delay 0.4
            set orderFields to my allTextFields(simulationWindow)
            if (count of orderFields) < 3 then error "未识别到模拟交易买入输入框"
            set priceField to item 1 of orderFields
            set codeField to item 2 of orderFields
            set value of codeField to orderCode
            delay 0.8
            set codeValue to value of codeField as text
            set priceValue to value of priceField as text
            if codeValue does not contain orderCode then error "实时价格查询时股票代码填写失败"
            if not my isPositiveNumber(priceValue) then error "未能读取股票 " & orderCode & " 的模拟交易实时价格"
            if not my elementContainsText(simulationWindow, "模拟练习") then error "价格查询时无法确认模拟交易状态"
            my restoreForegroundApp(previousApp)
            return "THS_SIMULATOR_V1" & linefeed & "SIMULATION|confirmed" & linefeed & "QUOTE|" & orderCode & "|" & priceValue
        end tell
    end tell
end readSimulatedQuote

on takeSnapshot(snapshotKind, hintCodes)
    if snapshotKind is "account" then return my takeAccountSnapshot(hintCodes, false)
    set my snapshotHintCodes to hintCodes
    if snapshotKind is not in {"funds", "positions", "orders"} then error "未知查询类型：" & snapshotKind
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到包含“模拟练习”的窗口，已停止"
            -- 快照只读取当前模拟账户界面，不点击连接刷新按钮。
            -- 非交易时段或连接异常时该按钮可能让同花顺的 AXPress 长时间不返回，
            -- 下单/撤单/报价路径仍会在操作前主动刷新连接。
            -- 资金汇总在所有模拟交易子页常驻，直接读取可避免无意义的页面就绪轮询。
            if snapshotKind is not "funds" then
                my navigateTo(simulationWindow, snapshotKind)
                my waitForSimulationPage(simulationWindow, snapshotKind)
            end if
            if not my elementContainsText(simulationWindow, "模拟练习") then error "查询前无法确认模拟交易状态，已停止"
            set snapshotResult to my snapshotWindow(simulationWindow, snapshotKind)
            my restoreForegroundApp(previousApp)
            set my snapshotHintCodes to {}
            return snapshotResult
        end tell
    end tell
end takeSnapshot

on takeAccountSnapshot(hintCodes, passive)
    set my snapshotHintCodes to hintCodes
    -- 单次会话读取资金+持仓，避免两次 osascript 冷启动和重复找窗口。
    -- 只读同步跳过 refreshSimulationConnection，省 1.5 秒且非交易时段无需重连。
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error (my windowUnavailableReason(it))
            if not passive then
                my navigateTo(simulationWindow, "positions")
                my waitForSimulationPage(simulationWindow, "positions")
            end if
            if not my elementContainsText(simulationWindow, "模拟练习") then error "查询前无法确认模拟交易状态，已停止"
            set positionsPart to my snapshotWindow(simulationWindow, "positions")
            set fundsPart to positionsPart
            -- Passive reads intentionally never navigate.  The current page
            -- normally contains the persistent funds summary; if it does not,
            -- parsing the same page as funds is still safer than clicking a
            -- tab after close and popping "begin failed".
            if not passive and not my snapshotContainsFunds(positionsPart) then
                my navigateTo(simulationWindow, "funds")
                my waitForSimulationPage(simulationWindow, "funds")
                set fundsPart to my snapshotWindow(simulationWindow, "funds")
            else if passive then
                set fundsPart to my snapshotWindow(simulationWindow, "funds")
            end if
            my restoreForegroundApp(previousApp)
            set my snapshotHintCodes to {}
            return my mergeAccountSnapshot(positionsPart, fundsPart)
        end tell
    end tell
end takeAccountSnapshot

on snapshotContainsFunds(snapshotText)
    set snapshotText to snapshotText as text
    return snapshotText contains "可用" and snapshotText contains "资产"
end snapshotContainsFunds

on mergeAccountSnapshot(positionsPart, fundsPart)
    set outputLines to {"THS_SIMULATOR_V1", "MODE|account", "SIMULATION|confirmed"}
    my appendSnapshotLines(outputLines, positionsPart as text)
    if fundsPart is not positionsPart then my appendSnapshotLines(outputLines, fundsPart as text)
    return my joinList(outputLines, linefeed)
end mergeAccountSnapshot

on appendSnapshotLines(outputLines, snapshotText)
    repeat with lineText in paragraphs of snapshotText
        set lineText to lineText as text
        if lineText starts with "ROW|" or lineText starts with "TEXT|" then
            if lineText is not in outputLines then set end of outputLines to lineText
        end if
    end repeat
end appendSnapshotLines

on submitSimulatedOrder(orderSide, orderCode, requestedPrice, orderQuantity)
    if orderSide is not in {"buy", "sell"} then error "交易方向必须是 buy 或 sell"
    if not my isStockCode(orderCode) then error "股票代码必须是6位数字"
    if not my isPositiveInteger(orderQuantity) then error "委托数量必须是正整数"
    if requestedPrice is not "AUTO" and requestedPrice is not "auto" and not my isPositiveNumber(requestedPrice) then error "委托价格必须是正数或 AUTO"
    set previousApp to my saveForegroundApp()
    set sideLabel to "买入"
    set submitLabel to "确定买入"
    set confirmTitle to "买入委托"
    set flowMarker to "FLOW|buy|direct_form"
    if orderSide is "sell" then
        set sideLabel to "卖出"
        set submitLabel to "确定卖出"
        set confirmTitle to "卖出委托"
        set flowMarker to "FLOW|sell|positions_double_click"
    end if

    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到同花顺模拟交易窗口，已取消下单"
            if not my elementContainsText(simulationWindow, "模拟练习") then error "当前窗口不是同花顺模拟交易，已取消下单"

            -- 不在下单路径点击无名连接刷新按钮：该控件的 AXPress 在 Swift 版本中
            -- 可能阻塞整个 osascript，导致尚未进入持仓页就超时。账户快照已确认
            -- 当前是模拟账户；若交易页不可用，后续表单/回查会明确失败。
            if orderSide is "sell" then
                -- 同花顺模拟盘的卖出表单必须从持仓行进入。直接点击“卖出”只打开空表单，
                -- 不能可靠地带出可卖数量/证券上下文，部分版本甚至不会真正生成委托。
                -- System Events 对非前台窗口的 click 可能永久挂起，表现为 30s 超时且界面无双击。
                my logSellStep("sell_begin|" & orderCode)
                my bringProcessToFront(it)
                my logSellStep("frontmost_ok")
                my navigateTo(simulationWindow, "positions")
                my logSellStep("positions_page")
                set positionRow to my waitForPositionRow(simulationWindow, orderCode, 80)
                if positionRow is missing value then error "持仓页未找到可卖股票 " & orderCode & "，已取消下单"
                my logSellStep("position_row_found|" & orderCode)
                -- 双击偶发未打开卖出页（焦点未稳/界面忙）；最多重试 3 次并重新定位持仓行。
                set openedSellPage to false
                repeat with clickAttempt from 1 to 3
                    my bringProcessToFront(it)
                    set positionRow to my waitForPositionRow(simulationWindow, orderCode, 50)
                    if positionRow is missing value then error "持仓页未找到可卖股票 " & orderCode & "，已取消下单"
                    my logSellStep("double_click_attempt|" & clickAttempt)
                    my doubleClickPositionRow(positionRow, orderCode)
                    my waitForSimulationPage(simulationWindow, "sell")
                    if my simulationPageReady(simulationWindow, "sell") then
                        set openedSellPage to true
                        exit repeat
                    end if
                    my logSellStep("double_click_retry|" & clickAttempt)
                    my navigateTo(simulationWindow, "positions")
                    delay 0.3
                end repeat
                if not openedSellPage then error "双击持仓行后未进入卖出页面，已取消下单"
                my logSellStep("sell_page_ready")
            else
                my navigateTo(simulationWindow, "buy")
                if not my simulationPageReady(simulationWindow, "buy") then error "未能切换到模拟交易买入页面（可能仍停留在另一页）"
            end if

            tell simulationWindow
                set orderFields to my allTextFields(simulationWindow)
                if (count of orderFields) < 3 then error "未识别到交易输入框，请先手动打开模拟交易的" & sideLabel & "页面"

                -- 当前同花顺 macOS 模拟交易页辅助功能顺序：价格、代码、数量。
                set priceField to item 1 of orderFields
                set codeField to item 2 of orderFields
                set quantityField to item 3 of orderFields

                set openedCodeValue to value of codeField as text
                if orderSide is "sell" and openedCodeValue does not contain orderCode then error "双击持仓行后卖出股票代码不一致，已取消下单"
                set value of codeField to orderCode
                delay 0.8
                set value of quantityField to orderQuantity
                delay 0.4
                if requestedPrice is not "AUTO" and requestedPrice is not "auto" then set value of priceField to requestedPrice
                delay 0.2

                set codeValue to value of codeField as text
                set priceValue to value of priceField as text
                set quantityValue to value of quantityField as text

                if codeValue does not contain orderCode then error "股票代码填写失败，已取消下单"
                if requestedPrice is not "AUTO" and requestedPrice is not "auto" then
                    if my normalizedNumber(priceValue) is not my normalizedNumber(requestedPrice) then error "委托价格填写失败，已取消下单"
                end if
                if my normalizedNumber(quantityValue) is not my normalizedNumber(orderQuantity) then error "委托数量填写失败，已取消下单"
                if not my isPositiveNumber(priceValue) then error "未能从交易页读取有效委托价格，已取消下单"
                if not my elementContainsText(simulationWindow, "模拟练习") then error "提交前无法确认模拟交易状态，已取消下单"

                set submitButton to my findNamedControl(simulationWindow, {submitLabel})
                if submitButton is missing value then error "未识别到“" & submitLabel & "”按钮，界面结构可能已变化"
                if not (enabled of submitButton) then error "“" & submitLabel & "”按钮不可用，已取消下单"
                my pressControl(submitButton)

                set confirmationSheet to my waitForSheet(simulationWindow, 30)
                if confirmationSheet is missing value then error "未出现" & confirmTitle & "确认弹窗"
                if not my elementContainsText(confirmationSheet, confirmTitle) then error "弹窗不是" & confirmTitle & "确认，已取消下单"
                if not my elementContainsText(confirmationSheet, orderCode) then error "确认弹窗中的股票代码不一致，已取消下单"
                if not my elementContainsText(confirmationSheet, orderQuantity) then error "确认弹窗中的委托数量不一致，已取消下单"
                if not my elementContainsText(simulationWindow, "模拟练习") then error "确认前无法确认模拟交易状态，已取消下单"

                set confirmButton to my findNamedControl(confirmationSheet, {"确认"})
                if confirmButton is missing value then error "未识别到委托确认按钮"
                my pressControl(confirmButton)
            end tell

            -- 等待委托结果；若出现结果弹窗，读取后关闭。
            delay 0.8
            set resultText to ""
            try
                tell simulationWindow
                    if (count of sheets) > 0 then
                        set resultSheet to sheet 1
                        set resultText to my collectElementText(resultSheet)
                        set dismissButton to my findNamedControl(resultSheet, {"确定", "确认", "知道了"})
                        if dismissButton is not missing value then my pressControl(dismissButton)
                    end if
                end tell
            end try

            delay 0.5
            set verificationResult to my verifyOrderInWindow(simulationWindow, orderSide, orderCode, priceValue, orderQuantity)
            my restoreForegroundApp(previousApp)
            return "ORDER_SUBMITTED|" & orderSide & "|" & orderCode & "|" & priceValue & "|" & orderQuantity & linefeed & flowMarker & linefeed & verificationResult & linefeed & "RESULT|" & my sanitize(resultText)
        end tell
    end tell
end submitSimulatedOrder

on verifyOrder(orderSide, orderCode, orderPrice, orderQuantity)
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到同花顺模拟交易窗口"
            my refreshSimulationConnection(simulationWindow)
            set verifyResult to my verifyOrderInWindow(simulationWindow, orderSide, orderCode, orderPrice, orderQuantity)
            my restoreForegroundApp(previousApp)
            return verifyResult
        end tell
    end tell
end verifyOrder

on verifyOrderInWindow(simulationWindow, orderSide, orderCode, orderPrice, orderQuantity)
    if not my elementContainsText(simulationWindow, "模拟练习") then error "委托核验前无法确认模拟交易状态"
    my navigateTo(simulationWindow, "orders")
    delay 0.8
    set ordersSnapshot to my snapshotWindow(simulationWindow, "orders")
    set sideLabel to "买入"
    if orderSide is "sell" then set sideLabel to "卖出"
    if ordersSnapshot does not contain orderCode then error "委托列表中未找到股票代码 " & orderCode
    if ordersSnapshot does not contain orderQuantity then error "委托列表中未找到委托数量 " & orderQuantity
    if ordersSnapshot does not contain sideLabel then error "委托列表中未找到" & sideLabel & "方向的委托 " & orderCode
    return "ORDER_VERIFIED|" & orderSide & "|" & orderCode & "|" & orderPrice & "|" & orderQuantity & linefeed & ordersSnapshot
end verifyOrderInWindow

on navigateTo(simulationWindow, destination)
    -- 持仓页不能因为旧表格仍挂在 AX 树上就直接返回。重新选中一次持仓页，
    -- 让同花顺有机会重新查询/重建持仓表；否则后面的双击可能命中尚未刷新的行。
    if destination is not "positions" and my simulationPageReady(simulationWindow, destination) then return
    set labels to {}
    if destination is "funds" then
        set labels to {"资金股份", "资金", "持仓"}
    else if destination is "positions" then
        set labels to {"持仓", "资金股份"}
    else if destination is "orders" then
        set labels to {"当日委托", "委托", "查询"}
    else if destination is "buy" then
        set labels to {"买入", "普通买入"}
    else if destination is "sell" then
        set labels to {"卖出", "普通卖出"}
    end if

    set targetControl to my findNamedControl(simulationWindow, labels)
    if targetControl is missing value then
        repeat with labelText in labels
            set targetControl to my findClickableByText(simulationWindow, labelText as text)
            if targetControl is not missing value then exit repeat
        end repeat
    end if
    if targetControl is not missing value then
        my pressControl(targetControl)
        if destination is in {"buy", "sell", "funds", "positions", "orders"} then
            my waitForSimulationPage(simulationWindow, destination)
        end if
        return
    end if

    error "无法切换到模拟交易页面：" & destination
end navigateTo

on findClickableByText(rootElement, wantedText)
    tell application "System Events"
        try
            set allItems to {rootElement} & (entire contents of rootElement)
        on error
            set allItems to {rootElement}
        end try
        repeat with uiItem in allItems
            try
                set itemRole to role of uiItem as text
                if itemRole is in {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXTab"} then
                    set itemName to my elementName(uiItem)
                    if itemName contains wantedText then return contents of uiItem
                end if
            end try
        end repeat
    end tell
    return missing value
end findClickableByText

-- 切页后用轮询代替固定 delay：页面就绪立即继续，最多等 100×50ms=5s。
on waitForSimulationPage(simulationWindow, destination)
    repeat 100 times
        if my simulationPageReady(simulationWindow, destination) then return
        delay 0.05
    end repeat
end waitForSimulationPage

on simulationPageReady(simulationWindow, destination)
    if destination is "funds" then
        return my shallowTextContains(simulationWindow, {"可用资金", "可用金额", "总资产", "资金余额"})
    else if destination is "positions" then
        -- 资金汇总在买入/卖出/委托/持仓页都会常驻，不能据此判断已进入持仓页。
        if my shallowTextContains(simulationWindow, {"可用股份", "证券代码", "股票余额"}) then return true
        return my hasSmallPositionTable(simulationWindow)
    else if destination is "orders" then
        if my shallowTextContains(simulationWindow, {"委托状态", "当日委托"}) then return true
        return my hasOrderTable(simulationWindow)
    else if destination is "buy" then
        -- 买入/卖出 Tab 标签在另一页也可见，不能用「买入」「卖出」判断；以提交按钮为准。
        return my shallowTextContains(simulationWindow, {"确定买入"})
    else if destination is "sell" then
        return my shallowTextContains(simulationWindow, {"确定卖出"})
    end if
    return false
end simulationPageReady

on shallowTextContains(rootElement, wantedTexts)
    tell application "System Events"
        tell rootElement
            try
                repeat with t in static texts
                    set tx to my elementText(t)
                    repeat with i from 1 to count of wantedTexts
                        set wanted to item i of wantedTexts as text
                        if tx contains wanted then return true
                    end repeat
                end repeat
                repeat with b in buttons
                    set bn to my elementName(b)
                    repeat with i from 1 to count of wantedTexts
                        set wanted to item i of wantedTexts as text
                        if bn contains wanted then return true
                    end repeat
                end repeat
            end try
        end tell
    end tell
    return false
end shallowTextContains

on hasSmallPositionTable(simulationWindow)
    tell application "System Events"
        tell simulationWindow
            try
                repeat with scrollItem in scroll areas
                    repeat with tableItem in tables of scrollItem
                        set rowCount to count of rows of tableItem
                        set colCount to count of columns of tableItem
                        -- 当前持仓表为 15 列；允许空仓的 0 行表，但排除 2 列资金表和 13 列委托表。
                        if rowCount <= 100 and colCount >= 15 and colCount <= 20 then return true
                    end repeat
                end repeat
            end try
        end tell
    end tell
    return false
end hasSmallPositionTable

on hasOrderTable(simulationWindow)
    tell application "System Events"
        tell simulationWindow
            try
                repeat with scrollItem in scroll areas
                    repeat with tableItem in tables of scrollItem
                        set rowCount to count of rows of tableItem
                        set colCount to count of columns of tableItem
                        -- 当前同花顺委托表为 13 列；空委托时仍保留 0 行表格。
                        -- 持仓表为 15 列，因此不会把持仓页误判为委托页。
                        if rowCount <= 100 and colCount >= 3 and colCount <= 14 then return true
                    end repeat
                end repeat
            end try
        end tell
    end tell
    return false
end hasOrderTable

on refreshSimulationConnection(simulationWindow)
    -- 点击模拟练习标签页右侧的刷新图标，确保会话处于已连接状态。
    -- 该无名按钮位于"模拟"和"股票"两个标签之间，同行(y=75附近)。
    tell application "System Events"
        set simTab to missing value
        set tabY to 0
        set tabX to 0
        try
            repeat with b in buttons of simulationWindow
                try
                    set n to name of b as text
                    if n is "模拟" then
                        set simTab to b
                        set tabPos to position of b
                        set tabX to item 1 of tabPos
                        set tabY to item 2 of tabPos
                        exit repeat
                    end if
                end try
            end repeat
        end try
        if simTab is missing value then return
        repeat with b in buttons of simulationWindow
            try
                set n to name of b as text
                set btnPos to position of b
                set btnX to item 1 of btnPos
                set btnY to item 2 of btnPos
                -- 无名按钮、同行、在"模拟"右侧且不超过"股票"位置
                if n is "" and btnY is tabY and btnX > tabX and btnX < tabX + 200 then
                    my pressControl(b)
                    delay 1.5
                    return
                end if
            end try
        end repeat
    end tell
end refreshSimulationConnection

on ensureWindowAvailable(appProcess)
    -- count of windows 在页面切换/窗口刚出现/辅助功能树尚未就绪时可能瞬时返回 0，
    -- 这里加长重试并预热辅助功能树，避免明明窗口已打开却误报"未找到同花顺窗口"。
    -- Swift（AppKit）进程在非前台 Space 时 AX 树也可能延迟 1–2s 才出现。
    tell application "System Events"
        repeat 8 times
            try
                if (count of windows of appProcess) > 0 then return
            end try
            -- 预热：部分 Swift 应用的辅助功能树首次访问时未就绪，读一次进程属性可唤醒它
            try
                get name of appProcess
            end try
            delay 0.3
        end repeat
    end tell
    -- 这里不再主动切到前台；兜底激活统一交给 findSimulationWindow，避免重复抢焦点。
    -- 连续读不到窗口：抛出可区分根因的诊断，而不是笼统的"未找到窗口"
    error (my windowUnavailableReason(appProcess))
end ensureWindowAvailable

on bringProcessToFront(appProcess)
    -- 兜底激活：仅当同花顺确实不在前台时再设 frontmost，且永远不抢没有窗口的进程。
    -- Swift App 在多个桌面/Space 时 AX 树可能在非前台瞬间为空，抬升后再读一次。
    tell application "System Events"
        try
            -- 仅在已有窗口且尚未前台时激活；避免掩盖"窗口被最小化"等真实失败。
            if (count of windows of appProcess) is 0 then return
        end try
        try
            if frontmost of appProcess is true then
                delay 0.2
                return
            end if
        end try
        set my stoleFocus to true
        try
            set frontmost of appProcess to true
        end try
    end tell
    delay 0.5
end bringProcessToFront

on saveForegroundApp()
    -- 记录当前前台应用，以便操作结束后恢复焦点。
    tell application "System Events"
        try
            set frontApp to first application process whose frontmost is true
            return name of frontApp
        end try
    end tell
    return missing value
end saveForegroundApp

on restoreForegroundApp(previousAppName)
    -- 只有脚本确实抢过焦点时才恢复，避免不必要的分屏切换。
    if previousAppName is missing value then return
    if not my stoleFocus then return
    set my stoleFocus to false
    tell application "System Events"
        try
            set frontmost of process previousAppName to true
        end try
    end tell
end restoreForegroundApp

on windowUnavailableReason(appProcess)
    set stateText to ""
    tell application "System Events"
        try
            set stateText to " [visible=" & (visible of appProcess) & " frontmost=" & (frontmost of appProcess) & "]"
        end try
    end tell
    return "同花顺进程在运行但读不到任何窗口(count=0)" & stateText & "。常见根因：① 模拟交易窗口被最小化到 Dock；② 窗口在其它桌面/全屏 Space；③ 屏幕锁定或显示器休眠时 WindowServer 不暴露窗口；④ 启动服务器的程序(Terminal/uv)未获『辅助功能』授权。请确保模拟交易窗口在当前桌面、未最小化、屏幕未锁定后重试。"
end windowUnavailableReason

on findSimulationWindow(appProcess)
    tell application "System Events"
        -- 第一轮：最多 8 次静默扫描，让 Swift 应用的 AX 树有时间填充。命中即返回。
        repeat 8 times
            repeat with candidateWindow in windows of appProcess
                tell candidateWindow
                    if (exists button "模拟股票") or (exists static text "模拟练习") or (exists static text "模拟股票") then return candidateWindow
                end tell
            end repeat
            delay 0.3
        end repeat
        -- 静默扫描失败才走兜底激活；保证 Swift 应用即便未在最前也能完成读取，但仅此一次。
        my bringProcessToFront(appProcess)
        repeat 4 times
            repeat with candidateWindow in windows of appProcess
                tell candidateWindow
                    if (exists button "模拟股票") or (exists static text "模拟练习") or (exists static text "模拟股票") then return candidateWindow
                end tell
            end repeat
            delay 0.4
        end repeat
    end tell
    return missing value
end findSimulationWindow

on findNamedControl(rootElement, wantedNames)
    tell application "System Events"
        try
            if (role of rootElement as text) is "AXWindow" then
                set candidateItems to (buttons of rootElement)
            else
                set candidateItems to {rootElement} & (entire contents of rootElement)
            end if
        on error
            set candidateItems to {rootElement}
        end try
        repeat with uiItem in candidateItems
            try
                set itemRole to role of uiItem as text
                if itemRole is in {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXTab", "AXMenuItem"} then
                    set itemName to my elementName(uiItem)
                    if itemName is in wantedNames then return contents of uiItem
                end if
            end try
        end repeat
    end tell
    return missing value
end findNamedControl

on findOrderRow(rootElement, sideLabel, orderCode, orderQuantity)
    tell application "System Events"
        try
            repeat with scrollItem in scroll areas of rootElement
                repeat with tableItem in tables of scrollItem
                    if (count of rows of tableItem) <= 100 and (count of columns of tableItem) <= 20 then
                        repeat with uiItem in rows of tableItem
                            set rowText to my collectElementText(uiItem)
                            if rowText contains sideLabel and rowText contains orderCode and rowText contains orderQuantity then return contents of uiItem
                        end repeat
                    end if
                end repeat
            end repeat
        end try
    end tell
    return missing value
end findOrderRow

on findPositionRow(rootElement, orderCode)
    tell application "System Events"
        try
            repeat with scrollItem in scroll areas of rootElement
                repeat with tableItem in tables of scrollItem
                    set rowCount to count of rows of tableItem
                    set colCount to count of columns of tableItem
                    -- 持仓表通常为 15 列；与快照扫描一致放宽到 10–20，排除 2 列资金表。
                    if rowCount <= 100 and colCount >= 10 and colCount <= 20 then
                        repeat with uiItem in rows of tableItem
                            -- 只读取行的直接单元格。collectElementText 会遍历 entire contents，
                            -- Swift 表格行在部分版本上会因此阻塞，导致双击永远执行不到。
                            if my positionRowContainsCode(uiItem, orderCode) then return contents of uiItem
                        end repeat
                    end if
                end repeat
            end repeat
        end try
    end tell
    return missing value
end findPositionRow

on positionRowContainsCode(rowElement, orderCode)
    return my findPositionCodeCell(rowElement, orderCode) is not missing value
end positionRowContainsCode

on findPositionCodeCell(rowElement, orderCode)
    tell application "System Events"
        try
            repeat with cellItem in UI elements of rowElement
                if (my elementText(cellItem)) contains orderCode then return contents of cellItem
            end repeat
        end try
    end tell
    return missing value
end findPositionCodeCell

on waitForPositionRow(rootElement, orderCode, retryCount)
    -- 仅一次读到代码不代表持仓列表已经刷新完成：Swift 表格可能先暴露旧行，
    -- 随后才重建单元格。要求加载提示消失、目标行可交互，并连续多次读到同一行。
    set stableSamples to 0
    repeat with retryIndex from 1 to retryCount
        if my positionListBusy(rootElement) then
            set stableSamples to 0
        else
            set positionRow to my findPositionRow(rootElement, orderCode)
            if positionRow is not missing value and my positionRowInteractable(positionRow, orderCode) then
                set stableSamples to stableSamples + 1
                if stableSamples ≥ 6 then return positionRow
            else
                set stableSamples to 0
            end if
        end if
        delay 0.2
    end repeat
    return missing value
end waitForPositionRow

on positionListBusy(rootElement)
    return my shallowTextContains(rootElement, {"加载中", "正在加载", "查询中", "刷新中", "数据加载", "请稍候"})
end positionListBusy

on positionRowInteractable(rowElement, orderCode)
    set codeCell to my findPositionCodeCell(rowElement, orderCode)
    if codeCell is missing value then return false
    tell application "System Events"
        try
            -- 完整持仓行应已暴露主要单元格；空容器/半成品行不允许双击。
            if (count of UI elements of rowElement) < 10 then return false
            set cellPosition to position of codeCell
            set cellSize to size of codeCell
            if (item 1 of cellSize) ≤ 0 or (item 2 of cellSize) ≤ 0 then return false
            if (item 1 of cellPosition) < 0 or (item 2 of cellPosition) < 0 then return false
            return true
        on error
            return false
        end try
    end tell
end positionRowInteractable

on logSellStep(messageText)
    -- 卖出路径逐步落盘，超时后可对照 /tmp/ths-sell-debug.log 判断卡在前台/找行/双击哪一步。
    try
        do shell script "printf '%s %s\\n' \"$(date '+%Y-%m-%d %H:%M:%S')\" " & quoted form of (messageText as text) & " >> /tmp/ths-sell-debug.log"
    end try
end logSellStep

on isFinalOrderStatus(statusText)
    if statusText contains "已撤" then return true
    if statusText contains "全部成交" then return true
    if statusText contains "已成" then return true
    if statusText contains "废单" then return true
    if statusText contains "拒绝" then return true
    return false
end isFinalOrderStatus

on isCancelledOrderStatus(statusText)
    if statusText contains "已撤" then return true
    if statusText contains "撤单成功" then return true
    if statusText contains "已取消" then return true
    return false
end isCancelledOrderStatus

on pressControl(uiControl)
    tell application "System Events"
        try
            set isEnabled to true
            try
                set isEnabled to (enabled of uiControl)
            end try
            if not isEnabled then error "控件当前不可用 (enabled = false)"

            perform action "AXPress" of uiControl
            return
        end try
        try
            click uiControl
            return
        end try
    end tell
    error "控件无法点击：" & my elementName(uiControl)
end pressControl

on doubleClickControl(uiControl)
    tell application "System Events"
        try
            set isEnabled to true
            try
                set isEnabled to (enabled of uiControl)
            end try
            if not isEnabled then error "控件当前不可用 (enabled = false)"
            -- System Events 没有稳定的 AXDoubleClick 命令；两个短间隔 AXClick
            -- 是 Swift/AppKit 表格行可识别的双击手势。
            -- 必须带 timeout：非前台窗口上的 click 可能永不返回。
            with timeout of 5 seconds
                click uiControl
            end timeout
            delay 0.12
            with timeout of 5 seconds
                click uiControl
            end timeout
            return
        on error
            -- 某些版本的 AXRow 只接受 AXPress，作为同样的双击兜底。
            try
                with timeout of 5 seconds
                    perform action "AXPress" of uiControl
                end timeout
                delay 0.12
                with timeout of 5 seconds
                    perform action "AXPress" of uiControl
                end timeout
                return
            end try
        end try
    end tell
    error "持仓行无法双击"
end doubleClickControl

on doubleClickPositionRow(positionRow, orderCode)
    -- AXStaticText/AXRow 的 System Events click 会永久阻塞，AppleScript timeout 对该调用无效。
    -- 改为读取代码单元格屏幕坐标，再由 CoreGraphics 投递真正的双击鼠标事件。
    try
        set selected of positionRow to true
    end try
    delay 0.15
    set codeCell to my findPositionCodeCell(positionRow, orderCode)
    if codeCell is missing value then error "持仓行中未找到证券代码单元格：" & orderCode
    tell application "System Events"
        set cellPosition to position of codeCell
        set cellSize to size of codeCell
    end tell
    set clickX to (item 1 of cellPosition) + ((item 1 of cellSize) / 2)
    set clickY to (item 2 of cellPosition) + ((item 2 of cellSize) / 2)
    my logSellStep("double_click_core_graphics|" & orderCode & "|" & clickX & "|" & clickY)
    set helperPath to "/tmp/trending-polars-ths-double-click"
    try
        do shell script "test -x " & quoted form of helperPath & " && " & quoted form of helperPath & " " & (clickX as text) & " " & (clickY as text)
    on error errorMessage
        error "系统级双击工具不可用：" & errorMessage
    end try
    my logSellStep("double_click_core_graphics_done|" & orderCode)
end doubleClickPositionRow

on waitForSheet(parentWindow, retryCount)
    tell application "System Events"
        repeat with retryIndex from 1 to retryCount
            try
                if (count of sheets of parentWindow) > 0 then return sheet 1 of parentWindow
            end try
            delay 0.1
        end repeat
    end tell
    return missing value
end waitForSheet

on allTextFields(rootElement)
    set results to {}
    tell application "System Events"
        -- 优先使用窗口直属交易输入框，避免把行情搜索框误认成订单字段。
        try
            set directFields to text fields of rootElement
            if (count of directFields) >= 3 then return directFields
        end try
        try
            repeat with uiItem in entire contents of rootElement
                try
                    if (role of uiItem as text) is "AXTextField" then set end of results to contents of uiItem
                end try
            end repeat
        end try
    end tell
    return results
end allTextFields

on snapshotWindow(simulationWindow, snapshotKind)
    set hintCodes to my snapshotHintCodes
    set outputLines to {"THS_SIMULATOR_V1", "MODE|" & snapshotKind, "SIMULATION|confirmed"}
    set skipTextScan to snapshotKind is in {"account", "positions", "funds"}
    set tableRows to my collectSnapshotTableRows(simulationWindow, snapshotKind, hintCodes)
    repeat with i from 1 to count of tableRows
        set end of outputLines to item i of tableRows as text
    end repeat
    if skipTextScan and my snapshotScanComplete(hintCodes, tableRows) then return my joinList(outputLines, linefeed)
    if skipTextScan and (count of hintCodes) is 0 and my snapshotHasFundRows(tableRows) then return my joinList(outputLines, linefeed)
    if skipTextScan and (count of tableRows) > 0 and snapshotKind is "account" and my snapshotHasFundRows(tableRows) and my snapshotHasPositionRows(tableRows) then return my joinList(outputLines, linefeed)
    -- 委托快照完全来自表格；空表也代表当前没有可见委托。
    -- 避免继续读取某些 AXTextField.value 时被同花顺辅助功能接口永久阻塞。
    if snapshotKind is "orders" then return my joinList(outputLines, linefeed)
    tell application "System Events"
        try
            repeat with uiItem in (static texts of simulationWindow) & (text fields of simulationWindow) & (buttons of simulationWindow)
                set itemText to my elementText(uiItem)
                if itemText is not "" then set end of outputLines to "TEXT|" & my sanitize(itemText)
            end repeat
        end try
    end tell
    return my joinList(outputLines, linefeed)
end snapshotWindow

on collectSnapshotTableRows(simulationWindow, snapshotKind, hintCodes)
    set capturedRows to {}
    set my snapshotFundRowsFound to false
    set my snapshotFoundCodes to {}
    set primaryHandled to false
    set maxRowsToScan to 500
    tell application "System Events"
        tell simulationWindow
            repeat with scrollItem in scroll areas
                repeat with tableItem in tables of scrollItem
                    set rowCount to 0
                    try
                        set rowCount to count of rows of tableItem
                    end try
                    set colCount to 0
                    try
                        set colCount to count of columns of tableItem
                    end try
                    set tableShapeMatches to false
                    if snapshotKind is "funds" then
                        -- 当前同花顺资金汇总固定为两列：指标名、金额。
                        set tableShapeMatches to colCount is 2
                    else if snapshotKind is in {"account", "positions"} then
                        -- 账户页由两列资金表和 10–20 列持仓表组成；跳过一列导航表与行情大表。
                        set tableShapeMatches to colCount is 2 or (colCount >= 10 and colCount <= 20)
                    else if snapshotKind is "orders" then
                        set tableShapeMatches to colCount >= 3 and colCount <= 20
                    end if
                    -- AppleScript 没有 continue/cycle 语句；直接用条件包住可扫描表格。
                    -- 这里沿用 100 行上限，避免行情大表拖住辅助功能读取。
                    if tableShapeMatches and rowCount > 0 and rowCount <= 100 and rowCount <= maxRowsToScan then
                        set scanAllRows to false
                        if not primaryHandled then
                            if (count of hintCodes) > 0 then
                                if my tableContainsAnyHint(tableItem, hintCodes) then
                                    set scanAllRows to true
                                    set primaryHandled to true
                                end if
                            else if my tableLooksLikeAccount(tableItem) then
                                set scanAllRows to true
                                set primaryHandled to true
                            end if
                        end if
                        -- 每个小表都要检查：同花顺会把资金汇总与持仓拆成相邻的两个表格。
                        -- 只扫描第一个命中的表会漏掉全部持仓。
                        my appendTableSnapshotRows(tableItem, hintCodes, capturedRows, scanAllRows)
                        if (count of hintCodes) > 0 and my snapshotScanComplete(hintCodes, capturedRows) then
                            set plainRows to {}
                            repeat with i from 1 to count of capturedRows
                                set end of plainRows to (item i of capturedRows) as text
                            end repeat
                            return plainRows
                        end if
                    end if
                end repeat
                if (count of hintCodes) > 0 and my snapshotScanComplete(hintCodes, capturedRows) then exit repeat
            end repeat
        end tell
    end tell
    set plainRows to {}
    repeat with i from 1 to count of capturedRows
        set end of plainRows to (item i of capturedRows) as text
    end repeat
    return plainRows
end collectSnapshotTableRows

on appendTableSnapshotRows(tableItem, hintCodes, capturedRows, scanAllPositionRows)
    tell application "System Events"
        repeat with uiItem in rows of tableItem
            set rowValues to {}
            repeat with rowItem in UI elements of uiItem
                set cellText to my elementText(rowItem)
                if cellText is not "" then set end of rowValues to cellText
            end repeat
            if my shouldCaptureSnapshotRow(rowValues, hintCodes, scanAllPositionRows) then
                set rowLine to "ROW|" & my joinList(rowValues, "|")
                if rowLine is not in capturedRows then
                    set end of capturedRows to rowLine
                    if my isFundSummaryRow(rowValues) then set my snapshotFundRowsFound to true
                    set rowCode to my stockCodeInRowValues(rowValues)
                    if rowCode is not "" and rowCode is not in my snapshotFoundCodes then set end of my snapshotFoundCodes to rowCode
                end if
            end if
        end repeat
    end tell
end appendTableSnapshotRows

on tableContainsAnyHint(tableItem, hintCodes)
    tell application "System Events"
        repeat with uiItem in rows of tableItem
            set rowValues to {}
            repeat with rowItem in UI elements of uiItem
                set cellText to my elementText(rowItem)
                if cellText is not "" then set end of rowValues to cellText
            end repeat
            set rowCode to my stockCodeInRowValues(rowValues)
            if rowCode is not "" then
                repeat with i from 1 to count of hintCodes
                    if rowCode is (item i of hintCodes as text) then return true
                end repeat
            end if
        end repeat
    end tell
    return false
end tableContainsAnyHint

on tableLooksLikeAccount(tableItem)
    tell application "System Events"
        repeat with uiItem in rows of tableItem
            set rowValues to {}
            repeat with rowItem in UI elements of uiItem
                set cellText to my elementText(rowItem)
                if cellText is not "" then set end of rowValues to cellText
            end repeat
            if my isFundSummaryRow(rowValues) then return true
            if my stockCodeInRowValues(rowValues) is not "" then return true
        end repeat
    end tell
    return false
end tableLooksLikeAccount

on shouldCaptureSnapshotRow(rowValues, hintCodes, scanAllPositionRows)
    if my isJunkSnapshotRow(rowValues) then return false
    if my isFundSummaryRow(rowValues) then return true
    set rowCode to my stockCodeInRowValues(rowValues)
    if rowCode is "" then return false
    if scanAllPositionRows then return true
    if (count of hintCodes) is 0 then return true
    repeat with i from 1 to count of hintCodes
        if rowCode is (item i of hintCodes as text) then return true
    end repeat
    return false
end shouldCaptureSnapshotRow

on snapshotScanComplete(hintCodes, capturedRows)
    if not my snapshotFundRowsFound then return false
    if (count of hintCodes) is 0 then return (count of capturedRows) > 0
    return (count of my snapshotFoundCodes) >= (count of hintCodes)
end snapshotScanComplete

on snapshotHasFundRows(capturedRows)
    repeat with i from 1 to count of capturedRows
        set rowLine to item i of capturedRows as text
        repeat with j from 1 to 4
            set labelText to item j of {"总资产", "可用金额", "可用资金", "资金余额"} as text
            if rowLine contains labelText then return true
        end repeat
    end repeat
    return false
end snapshotHasFundRows

on snapshotHasPositionRows(capturedRows)
    repeat with i from 1 to count of capturedRows
        set rowLine to item i of capturedRows as text
        if my rowLineHasStockCode(rowLine) then return true
    end repeat
    return false
end snapshotHasPositionRows

on rowLineHasStockCode(rowLine)
    set AppleScript's text item delimiters to "|"
    set cells to text items of rowLine
    set AppleScript's text item delimiters to ""
    repeat with j from 1 to count of cells
        if my isStockCode(item j of cells as text) then return true
    end repeat
    return false
end rowLineHasStockCode

on isJunkSnapshotRow(rowValues)
    if (count of rowValues) is 0 then return true
    if (count of rowValues) is 1 and (item 1 of rowValues as text) is "单元格" then return true
    return false
end isJunkSnapshotRow

on isFundSummaryRow(rowValues)
    if (count of rowValues) < 2 then return false
    set labelText to item 1 of rowValues as text
    return labelText is in {"总资产", "总市值", "总盈亏", "当日盈亏", "资金余额", "可取金额", "可用金额", "可用资金"}
end isFundSummaryRow

on stockCodeInRowValues(rowValues)
    repeat with i from 1 to count of rowValues
        set cellText to item i of rowValues as text
        if my isStockCode(cellText) then return cellText
    end repeat
    return ""
end stockCodeInRowValues

on collectElementText(rootElement)
    set textParts to {}
    tell application "System Events"
        set allItems to {rootElement}
        try
            set allItems to allItems & (entire contents of rootElement)
        end try
        repeat with uiItem in allItems
            set itemText to my elementText(uiItem)
            if itemText is not "" and itemText is not in textParts then set end of textParts to itemText
        end repeat
    end tell
    return my joinList(textParts, " ")
end collectElementText

on elementContainsText(rootElement, wantedText)
    tell application "System Events"
        try
            if (role of rootElement as text) is "AXWindow" then
                if wantedText is "模拟练习" then
                    if (exists button "模拟股票" of rootElement) or (exists static text "模拟练习" of rootElement) or (exists static text "模拟股票" of rootElement) then return true
                end if
                set allItems to (static texts of rootElement) & (text fields of rootElement) & (buttons of rootElement)
            else
                set allItems to {rootElement} & (entire contents of rootElement)
            end if
        on error
            set allItems to {rootElement}
        end try
        repeat with uiItem in allItems
            if my elementText(uiItem) contains wantedText then return true
        end repeat
    end tell
    return false
end elementContainsText

on elementName(uiItem)
    tell application "System Events"
        try
            set itemName to name of uiItem
            if itemName is not missing value then return itemName as text
        end try
        try
            set itemDescription to description of uiItem
            if itemDescription is not missing value then return itemDescription as text
        end try
    end tell
    return ""
end elementName

on elementText(uiItem)
    tell application "System Events"
        try
            set itemValue to value of uiItem
            if itemValue is not missing value and (itemValue as text) is not "" then return my sanitize(itemValue as text)
        end try
        set itemName to my elementName(uiItem)
        if itemName is not "" then return my sanitize(itemName)
    end tell
    return ""
end elementText

on sanitize(sourceText)
    set cleanText to sourceText as text
    set cleanText to my replaceText(return, " ", cleanText)
    set cleanText to my replaceText(linefeed, " ", cleanText)
    set cleanText to my replaceText("|", "｜", cleanText)
    return cleanText
end sanitize

on normalizedNumber(sourceText)
    set normalized to sourceText as text
    set normalized to my replaceText(",", "", normalized)
    set normalized to my replaceText(" ", "", normalized)
    try
        return (normalized as real) as text
    on error
        return normalized
    end try
end normalizedNumber

on isStockCode(sourceText)
    if (count sourceText) is not 6 then return false
    try
        sourceText as integer
        return true
    on error
        return false
    end try
end isStockCode

on isPositiveInteger(sourceText)
    try
        set numericValue to sourceText as integer
        return numericValue > 0
    on error
        return false
    end try
end isPositiveInteger

on isPositiveNumber(sourceText)
    try
        set numericValue to my normalizedNumber(sourceText) as real
        return numericValue > 0
    on error
        return false
    end try
end isPositiveNumber

on replaceText(findText, replacementText, sourceText)
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to findText
    set textItems to text items of sourceText
    set AppleScript's text item delimiters to replacementText
    set replacedText to textItems as text
    set AppleScript's text item delimiters to previousDelimiters
    return replacedText
end replaceText

on joinList(itemsToJoin, delimiterText)
    set previousDelimiters to AppleScript's text item delimiters
    set AppleScript's text item delimiters to delimiterText
    set joinedText to itemsToJoin as text
    set AppleScript's text item delimiters to previousDelimiters
    return joinedText
end joinList
