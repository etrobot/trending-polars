-- 同花顺生命周期辅助接口：启动后自动登录并切到模拟交易页，以及优雅退出。
--
-- 关于遍历方式的两个硬约束（都是在真机上实测踩出来的，改动前请先读）：
-- 1. `entire contents of window` 在同花顺上恒返回空列表（实测 count = 0），所以任何
--    依赖它的搜索都会静默地什么都找不到 —— 这正是"启动后不点左侧交易 icon"的根因。
--    要遍历只能用 `UI elements of ...` 自己按层取。
-- 2. 把控件引用存进变量（set b to UI element 7 of window 1）会让 System Events 把它
--    塌缩成「按名字」的引用（button "按钮" of window 1）。左侧 9 个导航 icon 的 name
--    全是"按钮"，塌缩后 press 永远打在第 1 个 icon 上。所以点击必须在同一个表达式里
--    按下标定位：perform action "AXPress" of UI element i of window 1。
--
-- 同花顺 macOS 版把交易相关控件（导航 icon、A股/模拟 tab、买入/卖出、持仓/委托…）
-- 全部挂在窗口的直属子元素层，因此这里统一按「窗口直属子元素 + 下标」操作：
-- 一次 Apple Event 批量取回 role/name/value/position/size 列表，再按下标点击。
--
-- 控件角色仍严格过滤：只点 AXButton/AXRadioButton/AXCheckBox/AXTab/AXLink/AXMenuItem，
-- 不碰静态文本或容器，避免 "begin failed" 之类的动作拒绝错误。

property thsProcessName : "同花顺"
property windowWaitSeconds : 30
property loginWaitSeconds : 40
-- 左侧导航自上而下第 6 个 56×56 icon 是"交易"（当前 macOS 版本）。
property tradeSidebarOrdinal : 6
property clickableRoles : {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXTab", "AXMenuItem"}
-- 侧栏 icon 的几何特征：贴着窗口左边缘、约 56×56、在 logo 下方。
property sidebarIconMinSide : 40
property sidebarIconMaxSide : 80
property sidebarIconMaxOffsetX : 80
property sidebarIconMinOffsetY : 70

on run argv
	if (count of argv) is 0 then error my usageText()
	set commandName to item 1 of argv as text
	if commandName is "launch-flow" then
		return my launchFlow()
	else if commandName is "quit" then
		return my quitThs()
	else if commandName is "probe" then
		return my probeThs()
	else if commandName is "dismiss-begin-failed" then
		return my dismissBeginFailedCommand()
	else
		error my usageText()
	end if
end run

on usageText()
	return "用法：launch-flow | quit | probe"
end usageText

-- ---------------------------------------------------------------------------
-- probe：只读探测，不碰任何控件
-- ---------------------------------------------------------------------------
-- 光看进程不够：同花顺进程活着但窗口数为 0 时（最小化到 Dock、在其它 Space、
-- 屏幕锁定）下单脚本一样会失败，所以窗口数才是"可用"的判据。

on probeThs()
	my dismissBeginFailedDialogs()
	tell application "System Events"
		if not (exists process thsProcessName) then return "THS_PROBE|running=false|windows=0"
		try
			set windowCount to count of windows of process thsProcessName
		on error
			return "THS_PROBE|running=true|windows=0"
		end try
		return "THS_PROBE|running=true|windows=" & windowCount
	end tell
end probeThs

-- ---------------------------------------------------------------------------
-- launch-flow
-- ---------------------------------------------------------------------------

on launchFlow()
	my dismissBeginFailedDialogs()
	tell application "System Events"
		if not (exists process thsProcessName) then error "同花顺进程尚未出现，请先由调用方 open -a 启动"
	end tell

	if not my waitForThsWindow(windowWaitSeconds) then error "等待同花顺窗口超时，未出现可交互窗口"
	-- 冷启动时窗口会先于内容出现（实测此刻 UI elements 里一个侧栏 icon 都没有），
	-- 直接找控件必然落空，所以要等到界面真正渲染出来。
	if not my waitForWindowContent(windowWaitSeconds) then error "同花顺窗口已出现但界面未渲染完成（未等到左侧导航 icon）"

	set loginClicked to my clickLoginButton()

	if not my waitForThsWindow(loginWaitSeconds) then error "LOGIN_PENDING|等待主交易界面超时（可能登录需手输或弹验证）"
	if loginClicked then
		if not my isMainTradingWindow() then my waitForMainTradingWindow(loginWaitSeconds)
	end if

	my clickSidebarTradeButton()
	my clickSimulationTab()

	return "LAUNCH_FLOW_DONE|已进入同花顺模拟交易页"
end launchFlow

on clickLoginButton()
	-- 已经在模拟练习页就不必再登录，免得误点真实账户的登录入口。
	if my windowTextContainsAny({"模拟练习"}) then return false
	set loginIndex to my findChildIndexByNames({"登录", "交易登录", "登录交易", "登录账号", "登录账户"}, true)
	if loginIndex is 0 then return false
	my pressChildAtIndex(loginIndex)
	return true
end clickLoginButton

on isMainTradingWindow()
	return my windowTextContainsAny({"资金股份", "持仓", "当日委托", "买入", "卖出", "模拟练习"})
end isMainTradingWindow

on waitForMainTradingWindow(maxSeconds)
	repeat (maxSeconds * 10) times
		if my thsWindowExists() and my isMainTradingWindow() then return true
		delay 0.1
	end repeat
	return false
end waitForMainTradingWindow

-- 窗口"有内容"的判据：左侧导航 icon 已经建出来（够取到第 N 个），或已经在交易模块里。
on waitForWindowContent(maxSeconds)
	repeat (maxSeconds * 10) times
		if my isTradingModuleActive() then return true
		if (count of my sidebarIconIndices()) ≥ tradeSidebarOrdinal then return true
		delay 0.1
	end repeat
	return false
end waitForWindowContent

-- ---------------------------------------------------------------------------
-- 左侧导航「交易」icon
-- ---------------------------------------------------------------------------

on clickSidebarTradeButton()
	-- 已经停在模拟交易页就直接返回；只看到"模拟练习"标签不算，必须买入/卖出也在。
	if my isActiveSimulationTradingPage() then return
	-- 已经进了交易模块（A股/模拟 tab、买卖面板都在）就不必再点侧栏。
	if my isTradingModuleActive() then return
	-- 登录/切页之后侧栏可能正在重建，再确认一次界面已渲染。
	my waitForWindowContent(windowWaitSeconds)

	-- 优先按名字找（别的版本可能给了可读名字），找不到再按侧栏几何位置取第 N 个 icon。
	set tradeIndex to my findChildIndexByNames({"交易", "交易首页"}, true)
	if tradeIndex is 0 then set tradeIndex to my sidebarIconIndex(tradeSidebarOrdinal)
	if tradeIndex is 0 then error "未识别到侧边栏交易按钮（侧栏 icon 数=" & (count of my sidebarIconIndices()) & "）"

	my pressChildAtIndex(tradeIndex)
	repeat 100 times
		if my isTradingModuleActive() then return
		delay 0.05
	end repeat
	error "点击侧边栏交易 icon 后未进入交易模块（未找到买入/卖出等特征）"
end clickSidebarTradeButton

-- 侧栏 icon 在 Accessibility 树里全部叫"按钮"，只能靠几何位置识别：
-- 贴着窗口左边缘、约 56×56、在 logo 下方，自上而下排成一列。
on sidebarIconIndices()
	set roleList to my childAttribute("role")
	set childCount to count of roleList
	if childCount is 0 then return {}
	set positionList to my childAttribute("position")
	set sizeList to my childAttribute("size")
	set windowOrigin to my windowOrigin()
	set originX to item 1 of windowOrigin
	set originY to item 2 of windowOrigin

	set matchedIndices to {}
	set matchedYs to {}
	repeat with childIndex from 1 to childCount
		try
			if (my textOf(item childIndex of roleList)) is "AXButton" then
				set childPosition to item childIndex of positionList
				set childSize to item childIndex of sizeList
				set childX to item 1 of childPosition
				set childY to item 2 of childPosition
				set childWidth to item 1 of childSize
				set childHeight to item 2 of childSize
				if childX ≤ originX + sidebarIconMaxOffsetX ¬
					and childY ≥ originY + sidebarIconMinOffsetY ¬
					and childWidth ≥ sidebarIconMinSide and childWidth ≤ sidebarIconMaxSide ¬
					and childHeight ≥ sidebarIconMinSide and childHeight ≤ sidebarIconMaxSide then
					set end of matchedIndices to childIndex
					set end of matchedYs to childY
				end if
			end if
		end try
	end repeat
	return my sortIndicesByY(matchedIndices, matchedYs)
end sidebarIconIndices

on sidebarIconIndex(wantedOrdinal)
	set orderedIndices to my sidebarIconIndices()
	if (count of orderedIndices) < wantedOrdinal then return 0
	return item wantedOrdinal of orderedIndices
end sidebarIconIndex

-- ---------------------------------------------------------------------------
-- 模拟 tab
-- ---------------------------------------------------------------------------

on isTradingModuleActive()
	if my windowTextContainsAny({"资金股份", "当日委托"}) then return true
	return my windowTextContainsAny({"买入"}) and my windowTextContainsAny({"卖出"})
end isTradingModuleActive

on isActiveSimulationTradingPage()
	if not my isTradingModuleActive() then return false
	return my windowTextContainsAny({"模拟练习"})
end isActiveSimulationTradingPage

on clickSimulationTab()
	if my windowTextContainsAny({"模拟练习"}) then return
	set simIndex to my findChildIndexByNames({"模拟", "模拟交易", "模拟练习", "模拟股票"}, true)
	if simIndex is 0 then set simIndex to my findChildIndexByNames({"模拟"}, false)
	if simIndex is 0 then error "未识别到模拟 tab"
	my pressChildAtIndex(simIndex)
	repeat 100 times
		if my windowTextContainsAny({"模拟练习"}) then return
		delay 0.05
	end repeat
	error "点击模拟 tab 后未确认进入模拟交易页（未找到“模拟练习”特征）"
end clickSimulationTab

-- ---------------------------------------------------------------------------
-- 窗口直属子元素：批量读属性 + 按下标点击
-- ---------------------------------------------------------------------------

-- 一次 Apple Event 取回整层的某个属性。逐元素取会产生上千次往返（实测 >3 分钟）。
-- 某些属性对部分控件不支持时整批会失败，这时退化成等长的空列表，保证下标对齐。
on childAttribute(attributeName)
	set childCount to my windowChildCount()
	if childCount is 0 then return {}
	tell application "System Events"
		try
			tell window 1 of process thsProcessName
				if attributeName is "role" then
					set rawList to role of UI elements
				else if attributeName is "name" then
					set rawList to name of UI elements
				else if attributeName is "value" then
					set rawList to value of UI elements
				else if attributeName is "position" then
					set rawList to position of UI elements
				else
					set rawList to size of UI elements
				end if
			end tell
			if (count of rawList) is childCount then return rawList
		end try
	end tell
	set fallbackList to {}
	repeat childCount times
		set end of fallbackList to missing value
	end repeat
	return fallbackList
end childAttribute

on windowChildCount()
	tell application "System Events"
		try
			return count of UI elements of window 1 of process thsProcessName
		on error
			return 0
		end try
	end tell
end windowChildCount

on windowOrigin()
	tell application "System Events"
		try
			return position of window 1 of process thsProcessName
		on error
			return {0, 0}
		end try
	end tell
end windowOrigin

-- 在窗口直属控件里找名字命中的下标；同花顺的登录/模拟/买卖按钮都在这一层。
on findChildIndexByNames(wantedNames, exactMatch)
	set roleList to my childAttribute("role")
	set childCount to count of roleList
	if childCount is 0 then return 0
	set nameList to my childAttribute("name")
	repeat with childIndex from 1 to childCount
		try
			if (my textOf(item childIndex of roleList)) is in clickableRoles then
				set childName to my textOf(item childIndex of nameList)
				if childName is not "" then
					repeat with i from 1 to count of wantedNames
						set wanted to item i of wantedNames as text
						if exactMatch then
							if childName is wanted then return childIndex
						else
							if childName contains wanted then return childIndex
						end if
					end repeat
				end if
			end if
		end try
	end repeat
	return 0
end findChildIndexByNames

-- 必须在同一个表达式里按下标 press：把引用存进变量会被塌缩成「按名字」的引用，
-- 而 9 个侧栏 icon 名字全是"按钮"，塌缩后永远点到第 1 个。
on pressChildAtIndex(childIndex)
	tell application "System Events"
		try
			if not (enabled of UI element childIndex of window 1 of process thsProcessName) then
				error "控件当前不可用 (enabled = false)"
			end if
		end try
		try
			perform action "AXPress" of UI element childIndex of window 1 of process thsProcessName
			return
		end try
		try
			click UI element childIndex of window 1 of process thsProcessName
			return
		end try
	end tell
	error "控件无法点击（窗口直属下标 " & childIndex & "）"
end pressChildAtIndex

-- 窗口直属层的按钮名 + 静态文本值，命中任意一个关键词即为真。
on windowTextContainsAny(wantedTexts)
	set nameList to my childAttribute("name")
	set childCount to count of nameList
	if childCount is 0 then return false
	set valueList to my childAttribute("value")
	repeat with childIndex from 1 to childCount
		set childName to my textOf(item childIndex of nameList)
		set childValue to my textOf(item childIndex of valueList)
		repeat with i from 1 to count of wantedTexts
			set wanted to item i of wantedTexts as text
			if childName contains wanted then return true
			if childValue contains wanted then return true
		end repeat
	end repeat
	return false
end windowTextContainsAny

on sortIndicesByY(indexList, yList)
	-- 插入排序：候选只有个位数，稳定且不依赖外部排序能力。
	set sortedIndices to {}
	set sortedYs to {}
	repeat with k from 1 to count of indexList
		set currentIndex to item k of indexList
		set currentY to item k of yList
		set insertAt to (count of sortedIndices) + 1
		repeat with j from 1 to count of sortedYs
			if currentY < (item j of sortedYs) then
				set insertAt to j
				exit repeat
			end if
		end repeat
		if insertAt is 1 then
			set sortedIndices to {currentIndex} & sortedIndices
			set sortedYs to {currentY} & sortedYs
		else if insertAt > (count of sortedIndices) then
			set end of sortedIndices to currentIndex
			set end of sortedYs to currentY
		else
			set sortedIndices to (items 1 thru (insertAt - 1) of sortedIndices) & {currentIndex} & (items insertAt thru -1 of sortedIndices)
			set sortedYs to (items 1 thru (insertAt - 1) of sortedYs) & {currentY} & (items insertAt thru -1 of sortedYs)
		end if
	end repeat
	return sortedIndices
end sortIndicesByY

on textOf(rawValue)
	if rawValue is missing value then return ""
	try
		return my sanitize(rawValue as text)
	on error
		return ""
	end try
end textOf

-- ---------------------------------------------------------------------------
-- 窗口定位与退出
-- ---------------------------------------------------------------------------

on waitForThsWindow(maxSeconds)
	set activationTried to false
	repeat (maxSeconds * 10) times
		if my thsWindowExists() then return true
		if not activationTried then
			-- 进程可能仍在运行，但窗口被隐藏、最小化或暂时挂在其它 Space。
			-- 只尝试一次恢复到当前桌面，避免整个等待期间反复抢焦点。
			my activateThsProcess()
			set activationTried to true
		end if
		delay 0.1
	end repeat
	return false
end waitForThsWindow

on activateThsProcess()
	try
		tell application "System Events"
			tell process thsProcessName to set frontmost to true
		end tell
	end try
	try
		tell application "同花顺" to activate
	end try
	delay 0.8
end activateThsProcess

on thsWindowExists()
	tell application "System Events"
		try
			if not (exists process thsProcessName) then return false
			return (count of windows of process thsProcessName) > 0
		on error
			return false
		end try
	end tell
end thsWindowExists

on quitThs()
	my dismissBeginFailedDialogs()
	tell application "System Events"
		if not (exists process thsProcessName) then return "QUIT_NOT_RUNNING|同花顺未在运行"
	end tell
	try
		tell application "System Events"
			repeat 30 times
				tell process thsProcessName to set frontmost to true
				if not (exists process thsProcessName) then return "QUIT_OK|同花顺已退出"
				delay 0.2
			end repeat
		end tell
	end try
	try
		tell application "同花顺" to quit
		delay 1
	end try
	tell application "System Events"
		repeat 30 times
			if not (exists process thsProcessName) then return "QUIT_OK|同花顺已退出"
			delay 0.2
		end repeat
	end tell
	return "QUIT_PENDING|同花顺未在超时内退出，由调用方 pkill 兜底"
end quitThs

-- ---------------------------------------------------------------------------
-- 文本工具
-- ---------------------------------------------------------------------------

on sanitize(sourceText)
	set cleanText to sourceText as text
	set cleanText to my replaceText(return, " ", cleanText)
	set cleanText to my replaceText(linefeed, " ", cleanText)
	set cleanText to my replaceText("|", "｜", cleanText)
	return cleanText
end sanitize

on replaceText(findText, replacementText, sourceText)
	set previousDelimiters to AppleScript's text item delimiters
	set AppleScript's text item delimiters to findText
	set textItems to text items of sourceText
	set AppleScript's text item delimiters to replacementText
	set replacedText to textItems as text
	set AppleScript's text item delimiters to previousDelimiters
	return replacedText
end replaceText

-- ---------------------------------------------------------------------------
-- begin failed 弹窗检测与关闭
-- 同花顺在收盘后/非交易时段对任何 UI 操作都可能弹出 "begin failed" 对话框，
-- 该弹窗会阻塞后续所有 AX 操作。此函数在所有交互入口处被调用，发现弹窗即自动关闭。
-- ---------------------------------------------------------------------------

on dismissBeginFailedDialogs()
	tell application "System Events"
		if not (exists process thsProcessName) then return false
		tell process thsProcessName
			repeat with w in windows
				-- 检查窗口直属 sheet（同花顺的 begin failed 通常以 sheet 形式出现）
				try
					repeat with s in sheets of w
						if my dismissSheetIfBeginFailed(s) then return true
					end repeat
				end try
				-- 兜底：检查窗口本身的 UI 元素（某些版本以独立弹窗形式出现）
				try
					if my dismissSheetIfBeginFailed(w) then return true
				end try
			end repeat
		end tell
	end tell
	return false
end dismissBeginFailedDialogs

-- 独立命令：仅检测并关闭 begin failed 弹窗，不执行其他操作。
-- 用于 launch-flow 失败后的错误恢复，避免弹窗阻塞后续操作。
on dismissBeginFailedCommand()
	if my dismissBeginFailedDialogs() then
		return "BEGIN_FAILED_DISMISSED|已关闭 begin failed 弹窗"
	end if
	return "BEGIN_FAILED_NONE|未发现 begin failed 弹窗"
end dismissBeginFailedCommand

on dismissSheetIfBeginFailed(rootElement)
	tell application "System Events"
		try
			-- 先快速检查文本内容
			set allText to ""
			try
				repeat with t in static texts of rootElement
					set allText to allText & (my textOf(value of t))
				end repeat
			end try
			if allText does not contain "begin failed" and allText does not contain "Begin failed" and allText does not contain "开始失败" then return false
		on error
			return false
		end try
		-- 确认是 begin failed 弹窗，点击确认按钮关闭
		try
			set confirmButton to my findButtonInSheet(rootElement, {"确定", "确认", "OK", "好", "知道了"})
			if confirmButton is not missing value then
				tell application "System Events"
					try
						perform action "AXPress" of confirmButton
					end try
					try
						click confirmButton
					end try
				end tell
				delay 0.5
				return true
			end if
		end try
	end tell
	return false
end dismissSheetIfBeginFailed

on findButtonInSheet(rootElement, wantedNames)
	tell application "System Events"
		try
			set allItems to {rootElement} & (entire contents of rootElement)
		on error
			set allItems to {rootElement}
		end try
		repeat with uiItem in allItems
			try
				set itemRole to role of uiItem as text
				if itemRole is in {"AXButton", "AXRadioButton", "AXCheckBox", "AXLink", "AXTab", "AXMenuItem"} then
					set itemName to ""
					try
						set itemName to name of uiItem as text
					end try
					if itemName is in wantedNames then return contents of uiItem
				end if
			end try
		end repeat
	end tell
	return missing value
end findButtonInSheet
