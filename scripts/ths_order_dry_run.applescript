-- 同花顺“模拟练习”辅助接口。
--
-- 只操作明确包含“模拟练习”的窗口；找不到、字段不一致或委托无法回查时立即失败。
--
-- 查询：
--   osascript scripts/ths_order_dry_run.applescript snapshot funds
--   osascript scripts/ths_order_dry_run.applescript snapshot positions
--   osascript scripts/ths_order_dry_run.applescript snapshot orders
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

on run argv
    if (count of argv) is 3 then
        return my submitSimulatedOrder("buy", item 1 of argv, item 2 of argv, item 3 of argv)
    end if

    if (count of argv) < 2 then error my usageText()
    set commandName to item 1 of argv as text

    if commandName is "snapshot" then
        if (count of argv) is not 2 then error my usageText()
        return my takeSnapshot(item 2 of argv as text)
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

    error my usageText()
end run

on usageText()
    return "用法：snapshot funds|positions|orders；quote 股票代码；order buy|sell 股票代码 价格|AUTO 数量；verify buy|sell 股票代码 价格|AUTO 数量；cancel buy|sell 股票代码 数量"
end usageText

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

on takeSnapshot(snapshotKind)
    if snapshotKind is not in {"funds", "positions", "orders"} then error "未知查询类型：" & snapshotKind
    set previousApp to my saveForegroundApp()
    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到包含“模拟练习”的窗口，已停止"
            my refreshSimulationConnection(simulationWindow)
            my navigateTo(simulationWindow, snapshotKind)
            delay 0.6
            if not my elementContainsText(simulationWindow, "模拟练习") then error "查询前无法确认模拟交易状态，已停止"
            set snapshotResult to my snapshotWindow(simulationWindow, snapshotKind)
            my restoreForegroundApp(previousApp)
            return snapshotResult
        end tell
    end tell
end takeSnapshot

on submitSimulatedOrder(orderSide, orderCode, requestedPrice, orderQuantity)
    if orderSide is not in {"buy", "sell"} then error "交易方向必须是 buy 或 sell"
    if not my isStockCode(orderCode) then error "股票代码必须是6位数字"
    if not my isPositiveInteger(orderQuantity) then error "委托数量必须是正整数"
    if requestedPrice is not "AUTO" and requestedPrice is not "auto" and not my isPositiveNumber(requestedPrice) then error "委托价格必须是正数或 AUTO"
    set previousApp to my saveForegroundApp()
    set sideLabel to "买入"
    set submitLabel to "确定买入"
    set confirmTitle to "买入委托"
    if orderSide is "sell" then
        set sideLabel to "卖出"
        set submitLabel to "确定卖出"
        set confirmTitle to "卖出委托"
    end if

    tell application "System Events"
        if not (exists process "同花顺") then error "同花顺尚未运行"
        tell process "同花顺"
            my ensureWindowAvailable(it)
            set simulationWindow to my findSimulationWindow(it)
            if simulationWindow is missing value then error "未找到同花顺模拟交易窗口，已取消下单"
            if not my elementContainsText(simulationWindow, "模拟练习") then error "当前窗口不是同花顺模拟交易，已取消下单"

            my refreshSimulationConnection(simulationWindow)
            my navigateTo(simulationWindow, orderSide)
            delay 0.5

            tell simulationWindow
                set orderFields to my allTextFields(simulationWindow)
                if (count of orderFields) < 3 then error "未识别到交易输入框，请先手动打开模拟交易的" & sideLabel & "页面"

                -- 当前同花顺 macOS 模拟交易页辅助功能顺序：价格、代码、数量。
                set priceField to item 1 of orderFields
                set codeField to item 2 of orderFields
                set quantityField to item 3 of orderFields

                set value of codeField to orderCode
                delay 0.8
                if requestedPrice is not "AUTO" and requestedPrice is not "auto" then set value of priceField to requestedPrice
                set value of quantityField to orderQuantity
                delay 0.4

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
            return "ORDER_SUBMITTED|" & orderSide & "|" & orderCode & "|" & priceValue & "|" & orderQuantity & linefeed & verificationResult & linefeed & "RESULT|" & my sanitize(resultText)
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
    if ordersSnapshot does not contain orderCode then error "委托列表中未找到股票代码 " & orderCode
    if ordersSnapshot does not contain orderQuantity then error "委托列表中未找到委托数量 " & orderQuantity
    return "ORDER_VERIFIED|" & orderSide & "|" & orderCode & "|" & orderPrice & "|" & orderQuantity & linefeed & ordersSnapshot
end verifyOrderInWindow

on navigateTo(simulationWindow, destination)
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
    if targetControl is not missing value then
        my pressControl(targetControl)
        return
    end if

    -- 有些版本把资金、持仓和委托放在同一页；页面已含目标内容时允许继续。
    if destination is "funds" and (my elementContainsText(simulationWindow, "可用资金")) then return
    if destination is "positions" and (my elementContainsText(simulationWindow, "可用股份")) then return
    if destination is "orders" and (my elementContainsText(simulationWindow, "委托状态")) then return
    if destination is "buy" and (my elementContainsText(simulationWindow, "确定买入")) then return
    if destination is "sell" and (my elementContainsText(simulationWindow, "确定卖出")) then return

    error "无法切换到模拟交易页面：" & destination
end navigateTo

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
                if n is "" and btnY = tabY and btnX > tabX and btnX < tabX + 200 then
                    my pressControl(b)
                    delay 1.5
                    return
                end if
            end try
        end repeat
        -- 部分按钮的 name 可能无值（missing value），尝试用另一方式匹配
        repeat with b in buttons of simulationWindow
            try
                set n to name of b as text
            on error
                set n to ""
            end try
            try
                set btnPos to position of b
                set btnX to item 1 of btnPos
                set btnY to item 2 of btnPos
                if n is "" and btnY = tabY and btnX > tabX and btnX < tabX + 200 then
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
    tell application "System Events"
        repeat 12 times
            try
                if (count of windows of appProcess) > 0 then return
            end try
            -- 预热：部分 Swift 应用的辅助功能树首次访问时未就绪，读一次进程属性可唤醒它
            try
                get name of appProcess
            end try
            delay 0.4
        end repeat
        -- 窗口不可见时，尝试将进程临时激活（处理分屏/其它 Space 的情况）
        my bringProcessToFront(appProcess)
        repeat 8 times
            try
                if (count of windows of appProcess) > 0 then return
            end try
            delay 0.4
        end repeat
    end tell
    -- 连续读不到窗口：抛出可区分根因的诊断，而不是笼统的"未找到窗口"
    error (my windowUnavailableReason(appProcess))
end ensureWindowAvailable

on bringProcessToFront(appProcess)
    -- 临时激活进程，使辅助功能树完整暴露（Swift 应用在非前台 Space 时 AX 树可能为空）。
    -- 仅在同花顺不是前台应用时才激活；已是前台时激活无意义且会导致分屏跳动。
    tell application "System Events"
        try
            if frontmost of appProcess is true then return
        end try
        set my stoleFocus to true
        try
            set frontmost of appProcess to true
        end try
    end tell
    delay 0.6
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
        -- 第一轮：后台静默扫描（同分屏时不需要 activate 即可成功）
        repeat 4 times
            repeat with candidateWindow in windows of appProcess
                tell candidateWindow
                    if (exists button "模拟股票") or (exists static text "模拟练习") or (exists static text "模拟股票") then return contents of candidateWindow
                end tell
            end repeat
            delay 0.35
        end repeat
        -- 第二轮：AXRaise + 预热辅助功能树后再扫描（仍不 activate）
        repeat with candidateWindow in windows of appProcess
            try
                perform action "AXRaise" of candidateWindow
            end try
            try
                get {title, position, size} of candidateWindow
            end try
        end repeat
        delay 0.4
        repeat with candidateWindow in windows of appProcess
            tell candidateWindow
                if (exists button "模拟股票") or (exists static text "模拟练习") or (exists static text "模拟股票") then return contents of candidateWindow
            end tell
        end repeat
        -- 第三轮：静默扫描失败，尝试激活进程（若已是前台则自动跳过，不会抢焦点）
        my bringProcessToFront(appProcess)
        repeat 3 times
            repeat with candidateWindow in windows of appProcess
                tell candidateWindow
                    if (exists button "模拟股票") or (exists static text "模拟练习") or (exists static text "模拟股票") then return contents of candidateWindow
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
                set candidateItems to (buttons of rootElement) & (static texts of rootElement)
            else
                set candidateItems to {rootElement} & (entire contents of rootElement)
            end if
        on error
            set candidateItems to {rootElement}
        end try
        repeat with uiItem in candidateItems
            set itemName to my elementName(uiItem)
            if itemName is in wantedNames then
                try
                    set itemRole to role of uiItem as text
                    if itemRole is in {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXStaticText", "AXMenuItem"} then return contents of uiItem
                end try
            end if
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
    set outputLines to {"THS_SIMULATOR_V1", "MODE|" & snapshotKind, "SIMULATION|confirmed"}
    tell application "System Events"
        -- 模拟账户区域是小表格；跳过行情区的数百行大表，避免 Swift AX 树展开阻塞。
        try
            repeat with scrollItem in scroll areas of simulationWindow
                repeat with tableItem in tables of scrollItem
                    if (count of rows of tableItem) <= 100 and (count of columns of tableItem) <= 20 then
                        repeat with uiItem in rows of tableItem
                            set rowValues to {}
                            repeat with rowItem in UI elements of uiItem
                                set cellText to my elementText(rowItem)
                                if cellText is not "" then set end of rowValues to cellText
                            end repeat
                            if (count of rowValues) > 0 then set end of outputLines to "ROW|" & my joinList(rowValues, "|")
                        end repeat
                    end if
                end repeat
            end repeat
        end try
        try
            repeat with uiItem in (static texts of simulationWindow) & (text fields of simulationWindow) & (buttons of simulationWindow)
                set itemText to my elementText(uiItem)
                if itemText is not "" then set end of outputLines to "TEXT|" & my sanitize(itemText)
            end repeat
        end try
    end tell
    return my joinList(outputLines, linefeed)
end snapshotWindow

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
